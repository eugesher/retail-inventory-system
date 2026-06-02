import { PinoLogger } from 'nestjs-pino';
import { Repository } from 'typeorm';

import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Product, ProductStatusEnum, ProductVariantStatusEnum } from '../../../domain';
import { CatalogTypeormRepository } from '../catalog-typeorm.repository';
import { ProductEntity } from '../product.entity';
import { ProductMapper } from '../product.mapper';
import { ProductVariantEntity } from '../product-variant.entity';
import { ProductVariantMapper } from '../product-variant.mapper';

const buildDomainProductWithVariant = (): Product => {
  const product = Product.create({
    name: 'Classic Tee',
    slug: 'classic-tee',
    description: 'A tee',
  });
  product.addVariant({
    sku: 'TEE-RED-M',
    gtin: '0123456789012',
    optionValues: { color: 'red', size: 'M' },
    weightG: 200,
    dimensionsMm: { l: 300, w: 200, h: 20 },
  });
  return product;
};

describe('catalog mappers', () => {
  describe('ProductVariantMapper', () => {
    it('round-trips a variant through domain → entity → domain preserving optionValues, dimensionsMm, and status', () => {
      const variant = buildDomainProductWithVariant().variants[0];

      const entity = {
        ...ProductVariantMapper.toEntity(variant, 7),
        id: 42,
        createdAt: new Date('2026-06-02T00:00:00Z'),
        updatedAt: new Date('2026-06-02T00:00:00Z'),
      } as ProductVariantEntity;

      const back = ProductVariantMapper.toDomain(entity);

      expect(back.id).toBe(42);
      expect(back.productId).toBe(7);
      expect(back.sku).toBe('TEE-RED-M');
      expect(back.gtin).toBe('0123456789012');
      expect(back.optionValues).toEqual({ color: 'red', size: 'M' });
      expect(back.dimensionsMm).toEqual({ l: 300, w: 200, h: 20 });
      expect(back.weightG).toBe(200);
      expect(back.status).toBe(ProductVariantStatusEnum.ACTIVE);
    });

    it('omits the id for an unsaved variant so TypeORM inserts it', () => {
      const variant = buildDomainProductWithVariant().variants[0];

      const entity = ProductVariantMapper.toEntity(variant, 7);

      expect(entity.id).toBeUndefined();
      expect(entity.productId).toBe(7);
      expect(entity.status).toBe(ProductVariantStatusEnum.ACTIVE);
    });
  });

  describe('ProductMapper', () => {
    it('round-trips the product root together with its variants', () => {
      const product = buildDomainProductWithVariant();

      const entity = {
        ...ProductMapper.toEntity(product),
        id: 7,
        status: ProductStatusEnum.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
        variants: [
          {
            ...ProductVariantMapper.toEntity(product.variants[0], 7),
            id: 42,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      } as ProductEntity;

      const back = ProductMapper.toDomain(entity);

      expect(back.id).toBe(7);
      expect(back.name).toBe('Classic Tee');
      expect(back.slug).toBe('classic-tee');
      expect(back.description).toBe('A tee');
      expect(back.status).toBe(ProductStatusEnum.ACTIVE);
      expect(back.variants).toHaveLength(1);
      expect(back.variants[0].sku).toBe('TEE-RED-M');
      expect(back.variants[0].optionValues).toEqual({ color: 'red', size: 'M' });
    });

    it('omits the id for an unsaved draft product and maps a null description to an empty string', () => {
      const entity = ProductMapper.toEntity(Product.create({ name: 'X', slug: 'x' }));
      expect(entity.id).toBeUndefined();
      expect(entity.status).toBe(ProductStatusEnum.DRAFT);

      const reconstituted = ProductMapper.toDomain({
        id: 1,
        name: 'X',
        slug: 'x',
        description: null,
        status: ProductStatusEnum.DRAFT,
        variants: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      } as ProductEntity);
      expect(reconstituted.description).toBe('');
    });
  });
});

describe('CatalogTypeormRepository', () => {
  let productRepo: jest.Mocked<Pick<Repository<ProductEntity>, 'existsBy' | 'findOne'>>;
  let variantRepo: jest.Mocked<Pick<Repository<ProductVariantEntity>, 'existsBy' | 'findOne'>>;
  let logger: PinoLoggerMock;
  let repository: CatalogTypeormRepository;

  beforeEach(() => {
    jest.resetAllMocks();
    productRepo = { existsBy: jest.fn(), findOne: jest.fn() } as never;
    variantRepo = { existsBy: jest.fn(), findOne: jest.fn() } as never;
    logger = makePinoLoggerMock();
    repository = new CatalogTypeormRepository(
      productRepo as unknown as Repository<ProductEntity>,
      variantRepo as unknown as Repository<ProductVariantEntity>,
      logger as unknown as PinoLogger,
    );
  });

  describe('existsBySlug / existsBySku', () => {
    it('delegates existsBySlug to the product repository and returns its result', async () => {
      productRepo.existsBy.mockResolvedValue(true);

      await expect(repository.existsBySlug('classic-tee')).resolves.toBe(true);
      expect(productRepo.existsBy).toHaveBeenCalledWith({ slug: 'classic-tee' });
    });

    it('delegates existsBySku to the variant repository and returns its result', async () => {
      variantRepo.existsBy.mockResolvedValue(false);

      await expect(repository.existsBySku('NOPE')).resolves.toBe(false);
      expect(variantRepo.existsBy).toHaveBeenCalledWith({ sku: 'NOPE' });
    });
  });

  describe('findById', () => {
    it('returns null when no row matches and loads the variants relation', async () => {
      productRepo.findOne.mockResolvedValue(null);

      await expect(repository.findById(99)).resolves.toBeNull();
      expect(productRepo.findOne).toHaveBeenCalledWith({
        where: { id: 99 },
        relations: { variants: true },
      });
    });

    it('maps the entity graph to a domain Product', async () => {
      productRepo.findOne.mockResolvedValue({
        id: 7,
        name: 'Classic Tee',
        slug: 'classic-tee',
        description: 'A tee',
        status: ProductStatusEnum.ACTIVE,
        variants: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      } as ProductEntity);

      const result = await repository.findById(7);

      expect(result?.slug).toBe('classic-tee');
      expect(result?.status).toBe(ProductStatusEnum.ACTIVE);
    });
  });
});
