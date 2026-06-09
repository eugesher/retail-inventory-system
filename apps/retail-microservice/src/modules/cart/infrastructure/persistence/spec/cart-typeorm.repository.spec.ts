import { PinoLogger } from 'nestjs-pino';
import { EntityManager, Repository } from 'typeorm';

import { CartStatusEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Cart, CartLine } from '../../../domain';
import { CartEntity } from '../cart.entity';
import { CartLineEntity } from '../cart-line.entity';
import { CartLineMapper } from '../cart-line.mapper';
import { CartMapper } from '../cart.mapper';
import { CartTypeormRepository } from '../cart-typeorm.repository';

const buildDomainCartWithLine = (): Cart =>
  Cart.reconstitute({
    id: 'cart-uuid-1',
    customerId: 'cust-1',
    currency: 'USD',
    status: CartStatusEnum.ACTIVE,
    lines: [
      new CartLine({
        id: 42,
        variantId: 7,
        quantity: 3,
        unitPriceSnapshotMinor: 1500,
        currencySnapshot: 'USD',
      }),
    ],
    version: 4,
  });

describe('cart mappers', () => {
  describe('CartLineMapper', () => {
    it('round-trips a line through domain → entity → domain', () => {
      const line = buildDomainCartWithLine().lines[0];

      const entity = {
        ...CartLineMapper.toEntity(line, 'cart-uuid-1'),
        // mysql2 returns BIGINT scalars as strings — assert the mapper coerces.
        variantId: '7' as unknown as number,
        unitPriceSnapshotMinor: '1500' as unknown as number,
        id: 42,
      } as CartLineEntity;

      const back = CartLineMapper.toDomain(entity);

      expect(back.id).toBe(42);
      expect(back.variantId).toBe(7);
      expect(back.quantity).toBe(3);
      expect(back.unitPriceSnapshotMinor).toBe(1500);
      expect(back.currencySnapshot).toBe('USD');
    });

    it('omits the id and carries the cartId for an unsaved line so TypeORM inserts it', () => {
      const line = new CartLine({
        id: null,
        variantId: 9,
        quantity: 1,
        unitPriceSnapshotMinor: 500,
        currencySnapshot: 'USD',
      });

      const entity = CartLineMapper.toEntity(line, 'cart-uuid-1');

      expect(entity.id).toBeUndefined();
      expect((entity.cart as { id: string }).id).toBe('cart-uuid-1');
      expect(entity.variantId).toBe(9);
    });
  });

  describe('CartMapper', () => {
    it('round-trips the cart root together with its lines and coerces the version', () => {
      const cart = buildDomainCartWithLine();

      const entity = {
        ...CartMapper.toEntity(cart),
        id: 'cart-uuid-1',
        version: '4' as unknown as number,
        createdAt: new Date('2026-06-10T00:00:00Z'),
        updatedAt: new Date('2026-06-10T00:00:00Z'),
        deletedAt: null,
        lines: [
          {
            ...CartLineMapper.toEntity(cart.lines[0], 'cart-uuid-1'),
            id: 42,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          },
        ],
      } as CartEntity;

      const back = CartMapper.toDomain(entity);

      expect(back.id).toBe('cart-uuid-1');
      expect(back.customerId).toBe('cust-1');
      expect(back.currency).toBe('USD');
      expect(back.status).toBe(CartStatusEnum.ACTIVE);
      expect(back.version).toBe(4);
      expect(back.lines).toHaveLength(1);
      expect(back.lines[0].variantId).toBe(7);
    });

    it('omits a null id from the root partial and never writes the version', () => {
      const cart = Cart.create({ customerId: null, currency: 'USD' });
      const partial = CartMapper.toEntity(cart);

      expect(typeof partial.id).toBe('string'); // create generates a concrete UUID
      expect('version' in partial).toBe(false);
      expect(partial.status).toBe(CartStatusEnum.ACTIVE);
    });
  });
});

describe('CartTypeormRepository', () => {
  let cartRepo: jest.Mocked<Pick<Repository<CartEntity>, 'findOne' | 'update'>> & {
    manager: { transaction: jest.Mock };
  };
  let lineRepo: jest.Mocked<Pick<Repository<CartLineEntity>, 'save' | 'createQueryBuilder'>>;
  let logger: PinoLoggerMock;
  let repository: CartTypeormRepository;

  beforeEach(() => {
    jest.resetAllMocks();
    lineRepo = { save: jest.fn(), createQueryBuilder: jest.fn() } as never;
    cartRepo = {
      findOne: jest.fn(),
      update: jest.fn(),
      manager: { transaction: jest.fn() },
    } as never;
    logger = makePinoLoggerMock();
    repository = new CartTypeormRepository(
      cartRepo as unknown as Repository<CartEntity>,
      lineRepo as unknown as Repository<CartLineEntity>,
      logger as unknown as PinoLogger,
    );
  });

  describe('findById', () => {
    it('returns null when no row matches and loads the lines relation ordered by id', async () => {
      cartRepo.findOne.mockResolvedValue(null);

      await expect(repository.findById('missing')).resolves.toBeNull();
      expect(cartRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'missing' },
        relations: { lines: true },
        order: { lines: { id: 'ASC' } },
      });
    });

    it('maps the entity graph to a domain Cart', async () => {
      cartRepo.findOne.mockResolvedValue({
        id: 'cart-uuid-1',
        customerId: 'cust-1',
        currency: 'USD',
        status: CartStatusEnum.ACTIVE,
        expiresAt: null,
        version: 2,
        lines: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      } as CartEntity);

      const result = await repository.findById('cart-uuid-1');

      expect(result?.id).toBe('cart-uuid-1');
      expect(result?.status).toBe(CartStatusEnum.ACTIVE);
      expect(result?.version).toBe(2);
    });
  });

  describe('reassignCustomer', () => {
    it('updates the customer_id column for the cart', async () => {
      cartRepo.update.mockResolvedValue({ affected: 1 } as never);

      await repository.reassignCustomer('cart-uuid-1', 'cust-2');

      expect(cartRepo.update).toHaveBeenCalledWith({ id: 'cart-uuid-1' }, { customerId: 'cust-2' });
    });
  });

  describe('save', () => {
    it('upserts the root + lines in a transaction and re-reads the saved graph', async () => {
      const cart = buildDomainCartWithLine();

      // Chainable delete-builder for the orphan reconciliation.
      const deleteBuilder = {
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      };
      lineRepo.createQueryBuilder.mockReturnValue(deleteBuilder as never);
      lineRepo.save.mockResolvedValue([] as never);

      const txnCartRepo = { save: jest.fn().mockResolvedValue({ id: 'cart-uuid-1' }) };
      const manager = {
        getRepository: jest.fn((entity) => (entity === CartLineEntity ? lineRepo : txnCartRepo)),
      } as unknown as EntityManager;
      cartRepo.manager.transaction.mockImplementation(
        async (cb: (m: EntityManager) => Promise<unknown>) => cb(manager),
      );

      // The post-commit re-read.
      const reloaded = {
        id: 'cart-uuid-1',
        customerId: 'cust-1',
        currency: 'USD',
        status: CartStatusEnum.ACTIVE,
        expiresAt: null,
        version: 5,
        lines: [
          {
            id: 42,
            cartId: 'cart-uuid-1',
            variantId: '7',
            quantity: 3,
            unitPriceSnapshotMinor: '1500',
            currencySnapshot: 'USD',
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      } as unknown as CartEntity;
      cartRepo.findOne.mockResolvedValue(reloaded);

      const result = await repository.save(cart);

      // Root upserted, orphans reconciled (kept id 42), survivor line saved.
      expect(txnCartRepo.save).toHaveBeenCalledTimes(1);
      expect(deleteBuilder.andWhere).toHaveBeenCalledWith('id NOT IN (:...keptIds)', {
        keptIds: [42],
      });
      expect(lineRepo.save).toHaveBeenCalledTimes(1);
      // Returned aggregate carries the re-read concrete line id + committed version.
      expect(result.id).toBe('cart-uuid-1');
      expect(result.version).toBe(5);
      expect(result.lines[0].id).toBe(42);
    });
  });
});
