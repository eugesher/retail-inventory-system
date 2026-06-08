import { PinoLogger } from 'nestjs-pino';
import { FindOperator, Repository } from 'typeorm';

import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { StockLevel } from '../../../domain';
import { StockLevelEntity } from '../stock-level.entity';
import { StockLocationEntity } from '../stock-location.entity';
import { StockTypeormRepository } from '../stock-typeorm.repository';

const makeLevelEntity = (overrides: Partial<StockLevelEntity> = {}): StockLevelEntity =>
  ({
    id: 10,
    variantId: 1,
    stockLocationId: 'default-warehouse',
    quantityOnHand: 7,
    quantityAllocated: 0,
    quantityReserved: 0,
    version: 1,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    deletedAt: null,
    ...overrides,
  }) as StockLevelEntity;

const makeLocationEntity = (overrides: Partial<StockLocationEntity> = {}): StockLocationEntity =>
  ({
    id: 'default-warehouse',
    name: 'Default Warehouse',
    code: 'default-warehouse',
    type: 'warehouse',
    address: null,
    gln: null,
    active: true,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    deletedAt: null,
    ...overrides,
  }) as StockLocationEntity;

describe('StockTypeormRepository', () => {
  let levelRepo: jest.Mocked<Pick<Repository<StockLevelEntity>, 'findOne' | 'find' | 'save'>>;
  let locationRepo: jest.Mocked<Pick<Repository<StockLocationEntity>, 'findOne' | 'find'>>;
  let logger: PinoLoggerMock;
  let repository: StockTypeormRepository;

  beforeEach(() => {
    jest.resetAllMocks();
    levelRepo = { findOne: jest.fn(), find: jest.fn(), save: jest.fn() } as never;
    locationRepo = { findOne: jest.fn(), find: jest.fn() } as never;
    logger = makePinoLoggerMock();
    repository = new StockTypeormRepository(
      levelRepo as unknown as Repository<StockLevelEntity>,
      locationRepo as unknown as Repository<StockLocationEntity>,
      logger as unknown as PinoLogger,
    );
  });

  describe('saveStockLevel', () => {
    it('inserts a new level and re-reads for the concrete id', async () => {
      const level = StockLevel.initialAt(1, 'default-warehouse');
      // No existing row → the lookup returns null; save assigns id 10; re-read.
      levelRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(makeLevelEntity());
      levelRepo.save.mockResolvedValue(makeLevelEntity());

      const result = await repository.saveStockLevel(level);

      // The first save argument carries no id → INSERT path.
      const savedArg = levelRepo.save.mock.calls[0][0] as Partial<StockLevelEntity>;
      expect(savedArg.id).toBeUndefined();
      expect(result.id).toBe(10);
      expect(result.quantityOnHand).toBe(7);
      // Re-read keyed on the generated id.
      expect(levelRepo.findOne).toHaveBeenLastCalledWith({ where: { id: 10 } });
    });

    it('resolves a detached level to the existing row id so save updates instead of colliding', async () => {
      const level = StockLevel.initialAt(1, 'default-warehouse');
      levelRepo.findOne
        .mockResolvedValueOnce(makeLevelEntity({ id: 7 })) // existing lookup
        .mockResolvedValueOnce(makeLevelEntity({ id: 7, version: 5 })); // re-read
      levelRepo.save.mockResolvedValue(makeLevelEntity({ id: 7, version: 5 }));

      const result = await repository.saveStockLevel(level);

      const savedArg = levelRepo.save.mock.calls[0][0] as Partial<StockLevelEntity>;
      expect(savedArg.id).toBe(7);
      expect(result.id).toBe(7);
      expect(result.version).toBe(5);
    });

    it('throws when the row vanishes after commit', async () => {
      const level = StockLevel.initialAt(1, 'default-warehouse');
      levelRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      levelRepo.save.mockResolvedValue(makeLevelEntity({ id: 9 }));

      await expect(repository.saveStockLevel(level)).rejects.toThrow('vanished after commit');
    });
  });

  describe('findStockLevelsByVariant', () => {
    it('filters by the supplied location ids with an IN clause', async () => {
      levelRepo.find.mockResolvedValue([]);

      await repository.findStockLevelsByVariant(1, ['a', 'b']);

      const findArg = levelRepo.find.mock.calls[0][0] as unknown as {
        where: { variantId: number; stockLocationId: FindOperator<string[]> };
      };
      expect(findArg.where.variantId).toBe(1);
      expect(findArg.where.stockLocationId).toBeInstanceOf(FindOperator);
      expect(findArg.where.stockLocationId.value).toEqual(['a', 'b']);
    });

    it('omits the location filter when no ids are supplied', async () => {
      levelRepo.find.mockResolvedValue([makeLevelEntity()]);

      const result = await repository.findStockLevelsByVariant(1);

      expect(levelRepo.find).toHaveBeenCalledWith({ where: { variantId: 1 } });
      expect(result).toHaveLength(1);
      expect(result[0].variantId).toBe(1);
    });
  });

  describe('locations', () => {
    it('findLocation maps the row to a StockLocation', async () => {
      locationRepo.findOne.mockResolvedValue(makeLocationEntity());

      const location = await repository.findLocation('default-warehouse');

      expect(locationRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'default-warehouse' },
      });
      expect(location?.id).toBe('default-warehouse');
      expect(location?.active).toBe(true);
    });

    it('findLocation returns null for a missing id', async () => {
      locationRepo.findOne.mockResolvedValue(null);
      await expect(repository.findLocation('nope')).resolves.toBeNull();
    });

    it('listLocations(true) restricts to active rows', async () => {
      locationRepo.find.mockResolvedValue([makeLocationEntity()]);

      await repository.listLocations(true);

      expect(locationRepo.find).toHaveBeenCalledWith({
        where: { active: true },
        order: { id: 'ASC' },
      });
    });

    it('listLocations() returns every row when activeOnly is omitted', async () => {
      locationRepo.find.mockResolvedValue([makeLocationEntity()]);

      const result = await repository.listLocations();

      expect(locationRepo.find).toHaveBeenCalledWith({ where: {}, order: { id: 'ASC' } });
      expect(result).toHaveLength(1);
    });
  });
});
