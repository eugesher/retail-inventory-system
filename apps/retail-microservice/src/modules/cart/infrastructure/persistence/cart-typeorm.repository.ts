import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DeepPartial, Repository } from 'typeorm';

import { BaseTypeormRepository } from '@retail-inventory-system/database';

import { Cart } from '../../domain';
import { ICartRepositoryPort } from '../../application/ports';
import { CartWriteConflictError } from '../../application/use-cases/cart-write-conflict.error';
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

  public async save(cart: Cart, expectedVersion?: number): Promise<Cart> {
    const cartId = cart.id;
    if (cartId === null) {
      throw new Error('CartTypeormRepository.save: cart id is unexpectedly null');
    }

    // One transaction for the root + its lines: a half-written graph (the cart
    // header committed but a line missing) would corrupt the subtotal the cart
    // view reports. When `expectedVersion` is supplied the root write is an
    // optimistic compare-and-swap (ADR-036); otherwise it is a plain insert (the
    // create path, no live row to race). The line reconciliation then deletes rows
    // the aggregate dropped and upserts the survivors + new lines.
    try {
      await this.cartRepository.manager.transaction(async (manager) => {
        const cartRepo = manager.getRepository(CartEntity);
        const lineRepo = manager.getRepository(CartLineEntity);

        await this.persistRoot(cartRepo, cart, cartId, expectedVersion);

        // Lines the aggregate still holds carry their persisted id; a line removed
        // in-memory is simply absent here. Delete the cart's rows that are no
        // longer present, then upsert the rest (TypeORM cascade covers only
        // insert/update, never remove — so removal is explicit). This runs only
        // after the root CAS succeeded, so a losing attempt writes no lines.
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
    } catch (error) {
      if (error instanceof CartWriteConflictError) {
        // The transaction rolled back on the lost CAS. Read the row's now-current
        // version on a fresh query (the default manager, not the rolled-back
        // transaction's snapshot) so the conflict signal carries the accurate
        // committed version the caller should refetch. A vanished row (never in
        // practice — a cart is not deleted) falls back to the version we targeted.
        const current = await this.cartRepository.findOne({ where: { id: cartId } });
        throw new CartWriteConflictError(
          cartId,
          current ? Number(current.version) : expectedVersion!,
        );
      }
      throw error;
    }

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

  // Persists the cart root. On the create path (`expectedVersion` undefined) a
  // plain `save` inserts via the caller-assigned UUID PK. On the update path it is
  // an optimistic compare-and-swap on the root `version` (ADR-036): the root
  // version is the aggregate's OCC anchor, so even a pure line edit (which changes
  // no root column) bumps it via `version = version + 1`, and the
  // `WHERE id = ? AND version = expectedVersion` predicate makes a concurrent
  // writer (who already bumped it) match zero rows — a retryable
  // `CartWriteConflictError` rather than a silent lost update. Two concurrent line
  // writes therefore serialize through this single UPDATE.
  private async persistRoot(
    cartRepo: Repository<CartEntity>,
    cart: Cart,
    cartId: string,
    expectedVersion: number | undefined,
  ): Promise<void> {
    if (expectedVersion === undefined) {
      await cartRepo.save(CartMapper.toEntity(cart));
      return;
    }

    const result = await cartRepo.update(
      { id: cartId, version: expectedVersion },
      {
        customerId: cart.customerId,
        currency: cart.currency,
        status: cart.status,
        expiresAt: cart.expiresAt,
        version: (): string => 'version + 1',
      },
    );

    if (!result.affected) {
      // Signal a lost race; the outer `save` re-reads the committed version and
      // rethrows a conflict carrying it (kept out of this snapshot-bound tx).
      throw new CartWriteConflictError(cartId, expectedVersion);
    }
  }

  // Guest-promotion seam: an authenticated shopper claims a guest cart. A direct
  // column update (TypeORM's `@VersionColumn` advances the version on this update
  // too, which is fine — the OCC guard it feeds is a later capability). The owning
  // use case, with the ownership pre-checks, arrives with the cart operations.
  public async reassignCustomer(cartId: string, customerId: string): Promise<void> {
    await this.cartRepository.update({ id: cartId }, { customerId });
  }
}
