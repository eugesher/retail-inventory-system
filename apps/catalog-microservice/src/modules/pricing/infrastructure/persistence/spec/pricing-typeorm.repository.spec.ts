import { PinoLogger } from 'nestjs-pino';
import { EntityManager, Repository } from 'typeorm';

import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Price, TaxCategory } from '../../../domain';
import { PriceEntity } from '../price.entity';
import { PriceMapper } from '../price.mapper';
import { PricingTypeormRepository } from '../pricing-typeorm.repository';
import { TaxCategoryEntity } from '../tax-category.entity';
import { TaxCategoryMapper } from '../tax-category.mapper';

const NOW = new Date('2026-06-04T12:00:00.000Z');
const LATER = new Date('2026-06-05T12:00:00.000Z');

describe('pricing mappers', () => {
  describe('PriceMapper', () => {
    it('round-trips a price through domain → entity → domain', () => {
      const price = Price.set(
        { variantId: 42, currency: 'USD', amountMinor: 1999, priority: 5 },
        NOW,
      );

      const entity = {
        ...PriceMapper.toEntity(price),
        id: 7,
        createdAt: NOW,
        updatedAt: NOW,
      } as PriceEntity;

      const back = PriceMapper.toDomain(entity);

      expect(back.id).toBe(7);
      expect(back.variantId).toBe(42);
      expect(back.currency).toBe('USD');
      expect(back.amountMinor).toBe(1999);
      expect(back.priority).toBe(5);
      expect(back.isOpen()).toBe(true);
    });

    it('coerces BIGINT variant_id / amount_minor strings back to numbers', () => {
      // The mysql2 driver returns non-PK BIGINT columns as strings; toDomain
      // must hand the domain real numbers.
      const entity = {
        id: 7,
        variantId: '42' as unknown as number,
        currency: 'EUR',
        amountMinor: '250000' as unknown as number,
        validFrom: NOW,
        validTo: null,
        priority: 0,
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      } as PriceEntity;

      const back = PriceMapper.toDomain(entity);

      expect(back.variantId).toBe(42);
      expect(back.amountMinor).toBe(250000);
      expect(typeof back.variantId).toBe('number');
      expect(typeof back.amountMinor).toBe('number');
    });

    it('omits the id for an unsaved price so TypeORM inserts it', () => {
      const entity = PriceMapper.toEntity(
        Price.set({ variantId: 1, currency: 'USD', amountMinor: 100 }, NOW),
      );
      expect(entity.id).toBeUndefined();
    });
  });

  describe('TaxCategoryMapper', () => {
    it('round-trips a tax category through domain → entity → domain', () => {
      const category = TaxCategory.create({
        code: 'STANDARD',
        name: 'Standard rate',
        description: 'The default rate',
      });

      const entity = {
        ...TaxCategoryMapper.toEntity(category),
        id: 3,
        createdAt: NOW,
        updatedAt: NOW,
      } as TaxCategoryEntity;

      const back = TaxCategoryMapper.toDomain(entity);

      expect(back.id).toBe(3);
      expect(back.code).toBe('STANDARD');
      expect(back.name).toBe('Standard rate');
      expect(back.description).toBe('The default rate');
    });
  });
});

describe('PricingTypeormRepository', () => {
  let priceRepo: jest.Mocked<
    Pick<Repository<PriceEntity>, 'findOne'> & { manager: Pick<EntityManager, 'transaction'> }
  >;
  let taxCategoryRepo: jest.Mocked<
    Pick<Repository<TaxCategoryEntity>, 'findOne' | 'find' | 'save'>
  >;
  let logger: PinoLoggerMock;
  let repository: PricingTypeormRepository;

  beforeEach(() => {
    jest.resetAllMocks();
    priceRepo = {
      findOne: jest.fn(),
      manager: { transaction: jest.fn() },
    } as never;
    taxCategoryRepo = { findOne: jest.fn(), find: jest.fn(), save: jest.fn() } as never;
    logger = makePinoLoggerMock();
    repository = new PricingTypeormRepository(
      priceRepo as unknown as Repository<PriceEntity>,
      taxCategoryRepo as unknown as Repository<TaxCategoryEntity>,
      logger as unknown as PinoLogger,
    );
  });

  describe('findOpenPrice', () => {
    it('queries the open row for the scope and maps it', async () => {
      priceRepo.findOne.mockResolvedValue({
        id: 7,
        variantId: 42,
        currency: 'USD',
        amountMinor: 1999,
        validFrom: NOW,
        validTo: null,
        priority: 0,
      } as PriceEntity);

      const result = await repository.findOpenPrice(42, 'USD');

      expect(result?.id).toBe(7);
      expect(result?.isOpen()).toBe(true);
      const arg = priceRepo.findOne.mock.calls[0][0];
      expect(arg.where).toMatchObject({ variantId: 42, currency: 'USD' });
    });

    it('returns null when no open row matches', async () => {
      priceRepo.findOne.mockResolvedValue(null);
      await expect(repository.findOpenPrice(42, 'USD')).resolves.toBeNull();
    });
  });

  describe('appendPrice', () => {
    it('closes the predecessor and inserts the successor in one transaction, then re-reads', async () => {
      const update = jest.fn();
      const save = jest.fn().mockResolvedValue({ id: 99 });
      const txManager = { getRepository: jest.fn().mockReturnValue({ update, save }) };
      (priceRepo.manager.transaction as unknown as jest.Mock).mockImplementation(
        async (cb: (m: unknown) => Promise<unknown>) => cb(txManager),
      );
      priceRepo.findOne.mockResolvedValue({
        id: 99,
        variantId: 42,
        currency: 'USD',
        amountMinor: 2500,
        validFrom: LATER,
        validTo: null,
        priority: 0,
      } as PriceEntity);

      const predecessor = Price.reconstitute({
        id: 7,
        variantId: 42,
        currency: 'USD',
        amountMinor: 1999,
        validFrom: NOW,
        validTo: null,
        priority: 0,
      }).close(LATER);
      const successor = Price.set(
        { variantId: 42, currency: 'USD', amountMinor: 2500, validFrom: LATER },
        NOW,
      );

      const result = await repository.appendPrice(successor, predecessor);

      expect(update).toHaveBeenCalledWith(7, { validTo: LATER });
      expect(save).toHaveBeenCalledTimes(1);
      expect(priceRepo.findOne).toHaveBeenCalledWith({ where: { id: 99 } });
      expect(result.id).toBe(99);
      expect(result.amountMinor).toBe(2500);
    });

    it('inserts without an update when there is no predecessor', async () => {
      const update = jest.fn();
      const save = jest.fn().mockResolvedValue({ id: 1 });
      const txManager = { getRepository: jest.fn().mockReturnValue({ update, save }) };
      (priceRepo.manager.transaction as unknown as jest.Mock).mockImplementation(
        async (cb: (m: unknown) => Promise<unknown>) => cb(txManager),
      );
      priceRepo.findOne.mockResolvedValue({
        id: 1,
        variantId: 42,
        currency: 'USD',
        amountMinor: 1999,
        validFrom: NOW,
        validTo: null,
        priority: 0,
      } as PriceEntity);

      const successor = Price.set({ variantId: 42, currency: 'USD', amountMinor: 1999 }, NOW);
      await repository.appendPrice(successor, null);

      expect(update).not.toHaveBeenCalled();
      expect(save).toHaveBeenCalledTimes(1);
    });
  });

  describe('findTaxCategoryByCode', () => {
    it('returns the mapped category when found', async () => {
      taxCategoryRepo.findOne.mockResolvedValue({
        id: 3,
        code: 'STANDARD',
        name: 'Standard rate',
        description: null,
      } as TaxCategoryEntity);

      const result = await repository.findTaxCategoryByCode('STANDARD');

      expect(result?.code).toBe('STANDARD');
      expect(taxCategoryRepo.findOne).toHaveBeenCalledWith({ where: { code: 'STANDARD' } });
    });

    it('returns null when no category matches', async () => {
      taxCategoryRepo.findOne.mockResolvedValue(null);
      await expect(repository.findTaxCategoryByCode('NOPE')).resolves.toBeNull();
    });
  });
});
