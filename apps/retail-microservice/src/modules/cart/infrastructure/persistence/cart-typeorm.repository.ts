import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DeepPartial, Repository } from 'typeorm';

import { BaseTypeormRepository } from '@retail-inventory-system/database';

import { Cart } from '../../domain';
import { ICartRepositoryPort } from '../../application/ports';
import { CartEntity } from './cart.entity';
import { CartLineEntity } from './cart-line.entity';
import { CartLineMapper } from './cart-line.mapper';
import { CartMapper } from './cart.mapper';

// The single `@InjectRepository` site for the cart context. Extends
// `BaseTypeormRepository` for the `toDomain`/`toEntity` seam over the `Cart`
// aggregate; `save` is overridden because the root and its lines persist
// explicitly inside one transaction (the catalog idiom) and a removed line must
// be reconciled away. Returns domain types only — no TypeORM leak past this file
// (ADR-017).
@Injectable()
export class CartTypeormRepository
  extends BaseTypeormRepository<CartEntity, Cart>
  implements ICartRepositoryPort
{
  constructor(
    @InjectRepository(CartEntity)
    private readonly cartRepository: Repository<CartEntity>,
    @InjectRepository(CartLineEntity)
    private readonly cartLineRepository: Repository<CartLineEntity>,
    @InjectPinoLogger(CartTypeormRepository.name)
    private readonly logger: PinoLogger,
  ) {
    super(cartRepository);
  }

  protected toDomain(entity: CartEntity): Cart {
    return CartMapper.toDomain(entity);
  }

  protected toEntity(domain: Cart): DeepPartial<CartEntity> {
    return CartMapper.toEntity(domain);
  }

  public async findById(id: string): Promise<Cart | null> {
    const entity = await this.cartRepository.findOne({
      where: { id },
      relations: { lines: true },
      // Deterministic line order so the view is stable across reads.
      order: { lines: { id: 'ASC' } },
    });
    return entity ? CartMapper.toDomain(entity) : null;
  }

  public async save(cart: Cart): Promise<Cart> {
    const cartId = cart.id;
    if (cartId === null) {
      throw new Error('CartTypeormRepository.save: cart id is unexpectedly null');
    }

    // One transaction for the root + its lines: a half-written graph (the cart
    // header committed but a line missing) would corrupt the subtotal the cart
    // view reports. The root save upserts via the caller-assigned UUID PK
    // (TypeORM preloads by id → INSERT when absent, version-checked UPDATE when
    // present); the line reconciliation then deletes rows the aggregate dropped
    // and upserts the survivors + new lines.
    await this.cartRepository.manager.transaction(async (manager) => {
      const cartRepo = manager.getRepository(CartEntity);
      const lineRepo = manager.getRepository(CartLineEntity);

      await cartRepo.save(CartMapper.toEntity(cart));

      // Lines the aggregate still holds carry their persisted id; a line removed
      // in-memory is simply absent here. Delete the cart's rows that are no longer
      // present, then upsert the rest (TypeORM cascade covers only insert/update,
      // never remove — so removal is explicit).
      const keptIds = cart.lines.map((line) => line.id).filter((id): id is number => id !== null);

      const deleteQuery = lineRepo
        .createQueryBuilder()
        .delete()
        .from(CartLineEntity)
        .where('cart_id = :cartId', { cartId });
      if (keptIds.length > 0) {
        deleteQuery.andWhere('id NOT IN (:...keptIds)', { keptIds });
      }
      await deleteQuery.execute();

      const lineEntities = cart.lines.map((line) => CartLineMapper.toEntity(line, cartId));
      if (lineEntities.length > 0) {
        await lineRepo.save(lineEntities);
      }
    });

    this.logger.debug({ cartId, lineCount: cart.lines.length }, 'Cart persisted');

    // Re-read the full graph so the returned aggregate carries the concrete
    // generated `cart_line.id`s, the committed version, and the DB timestamps.
    // The row was just committed, so a miss here is an invariant breach.
    const reloaded = await this.findById(cartId);
    if (!reloaded) {
      throw new Error(`CartTypeormRepository.save: cart ${cartId} vanished after commit`);
    }
    return reloaded;
  }

  // Guest-promotion seam: an authenticated shopper claims a guest cart. A direct
  // column update (TypeORM's `@VersionColumn` advances the version on this update
  // too, which is fine — the OCC guard it feeds is a later capability). The owning
  // use case, with the ownership pre-checks, arrives with the cart operations.
  public async reassignCustomer(cartId: string, customerId: string): Promise<void> {
    await this.cartRepository.update({ id: cartId }, { customerId });
  }
}
