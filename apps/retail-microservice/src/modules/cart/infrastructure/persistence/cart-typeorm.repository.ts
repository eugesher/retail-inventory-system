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
      order: { lines: { id: 'ASC' } },
    });
    return entity ? CartMapper.toDomain(entity) : null;
  }

  public async save(cart: Cart, expectedVersion?: number): Promise<Cart> {
    const cartId = cart.id;
    if (cartId === null) {
      throw new Error('CartTypeormRepository.save: cart id is unexpectedly null');
    }

    try {
      await this.cartRepository.manager.transaction(async (manager) => {
        const cartRepo = manager.getRepository(CartEntity);
        const lineRepo = manager.getRepository(CartLineEntity);

        await this.persistRoot(cartRepo, cart, cartId, expectedVersion);

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
        const current = await this.cartRepository.findOne({ where: { id: cartId } });
        throw new CartWriteConflictError(
          cartId,
          current ? Number(current.version) : expectedVersion!,
        );
      }
      throw error;
    }

    this.logger.debug({ cartId, lineCount: cart.lines.length }, 'Cart persisted');

    const reloaded = await this.findById(cartId);
    if (!reloaded) {
      throw new Error(`CartTypeormRepository.save: cart ${cartId} vanished after commit`);
    }
    return reloaded;
  }

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
      throw new CartWriteConflictError(cartId, expectedVersion);
    }
  }

  public async reassignCustomer(cartId: string, customerId: string): Promise<void> {
    await this.cartRepository.update({ id: cartId }, { customerId });
  }
}
