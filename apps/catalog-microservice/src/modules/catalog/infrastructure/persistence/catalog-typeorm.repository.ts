import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DeepPartial, Repository } from 'typeorm';

import { BaseTypeormRepository } from '@retail-inventory-system/database';

import { Product, ProductStatusEnum, ProductVariant } from '../../domain';
import {
  ICatalogListActiveQuery,
  ICatalogListByCategoryQuery,
  ICatalogRepositoryPort,
  IProductPage,
} from '../../application/ports';
import { ProductEntity } from './product.entity';
import { ProductMapper } from './product.mapper';
import { ProductVariantEntity } from './product-variant.entity';
import { ProductVariantMapper } from './product-variant.mapper';

// The single `InjectRepository` site for the catalog context. Extends
// `BaseTypeormRepository` for the `toDomain`/`toEntity` seam; `save` is
// overridden because the root and its variants persist explicitly (cascade is
// off) and must commit atomically (ADR-019).
@Injectable()
export class CatalogTypeormRepository
  extends BaseTypeormRepository<ProductEntity, Product>
  implements ICatalogRepositoryPort
{
  constructor(
    @InjectRepository(ProductEntity)
    private readonly productRepository: Repository<ProductEntity>,
    @InjectRepository(ProductVariantEntity)
    private readonly variantRepository: Repository<ProductVariantEntity>,
    @InjectPinoLogger(CatalogTypeormRepository.name)
    private readonly logger: PinoLogger,
  ) {
    super(productRepository);
  }

  protected toDomain(entity: ProductEntity): Product {
    return ProductMapper.toDomain(entity);
  }

  protected toEntity(domain: Product): DeepPartial<ProductEntity> {
    return ProductMapper.toEntity(domain);
  }

  public async save(product: Product): Promise<Product> {
    // One transaction for the root + its children: a half-written graph (a
    // product with some variants missing) would violate the publish invariant
    // downstream. The unique-constraint violations (slug/sku) surface here as
    // a driver error — the write use case pre-checks via `existsBy*` so the
    // common case raises a typed domain error instead (ADR-025).
    const savedId = await this.productRepository.manager.transaction(async (manager) => {
      const productRepo = manager.getRepository(ProductEntity);
      const variantRepo = manager.getRepository(ProductVariantEntity);

      const savedProduct = await productRepo.save(ProductMapper.toEntity(product));

      const variantEntities = product.variants.map((variant) =>
        ProductVariantMapper.toEntity(variant, savedProduct.id),
      );
      if (variantEntities.length > 0) {
        await variantRepo.save(variantEntities);
      }

      return savedProduct.id;
    });

    this.logger.debug(
      { productId: savedId, variantCount: product.variants.length },
      'Catalog product persisted',
    );

    // Re-read the full graph so the returned aggregate carries the concrete
    // variant ids and DB-assigned timestamps. The row was just committed, so a
    // miss here is an invariant breach rather than a not-found.
    const reloaded = await this.findById(savedId);
    if (!reloaded) {
      throw new Error(`CatalogTypeormRepository.save: product ${savedId} vanished after commit`);
    }
    return reloaded;
  }

  public async findById(id: number): Promise<Product | null> {
    const entity = await this.productRepository.findOne({
      where: { id },
      relations: { variants: true },
    });
    return entity ? ProductMapper.toDomain(entity) : null;
  }

  public async findBySlug(slug: string): Promise<Product | null> {
    const entity = await this.productRepository.findOne({
      where: { slug },
      relations: { variants: true },
    });
    return entity ? ProductMapper.toDomain(entity) : null;
  }

  public existsBySlug(slug: string): Promise<boolean> {
    return this.productRepository.existsBy({ slug });
  }

  public existsBySku(sku: string): Promise<boolean> {
    return this.variantRepository.existsBy({ sku });
  }

  public async findVariantById(variantId: number): Promise<ProductVariant | null> {
    const entity = await this.variantRepository.findOne({ where: { id: variantId } });
    return entity ? ProductVariantMapper.toDomain(entity) : null;
  }

  public async listActive(query: ICatalogListActiveQuery): Promise<IProductPage> {
    const { page, size, search } = query;

    const builder = this.productRepository
      .createQueryBuilder('Product')
      .leftJoinAndSelect('Product.variants', 'ProductVariant')
      .where('Product.status = :status', { status: ProductStatusEnum.ACTIVE });

    if (search) {
      builder.andWhere('(Product.name LIKE :search OR Product.slug LIKE :search)', {
        search: `%${search}%`,
      });
    }

    const [entities, total] = await builder
      .orderBy('Product.id', 'DESC')
      .skip((page - 1) * size)
      .take(size)
      .getManyAndCount();

    return {
      items: entities.map((entity) => ProductMapper.toDomain(entity)),
      total,
      page,
      size,
    };
  }

  public async listActiveByCategoryIds(query: ICatalogListByCategoryQuery): Promise<IProductPage> {
    const { categoryIds, page, size } = query;

    // No ids → an empty page. The use case always passes at least the named
    // category's own id, but an `IN ()` with no values is invalid SQL, so guard.
    if (categoryIds.length === 0) {
      return { items: [], total: 0, page, size };
    }

    // Mirrors `listActive` (active products, newest first, variants eager-loaded)
    // and adds a category-membership filter as a parameterized id-subselect
    // against the bare `product_categories` table. `IN (subselect)` is implicitly
    // DISTINCT — a product attached to two of the ids appears once — so no
    // `.distinct()` is needed, and the to-many `variants` join still paginates
    // correctly because TypeORM resolves the root ids first when `take`/`skip` meet
    // a to-many join (the same shape `listActive` relies on).
    const [entities, total] = await this.productRepository
      .createQueryBuilder('Product')
      .leftJoinAndSelect('Product.variants', 'ProductVariant')
      .where('Product.status = :status', { status: ProductStatusEnum.ACTIVE })
      .andWhere(
        'Product.id IN (SELECT pc.product_id FROM product_categories pc WHERE pc.category_id IN (:...categoryIds))',
        { categoryIds },
      )
      .orderBy('Product.id', 'DESC')
      .skip((page - 1) * size)
      .take(size)
      .getManyAndCount();

    return {
      items: entities.map((entity) => ProductMapper.toDomain(entity)),
      total,
      page,
      size,
    };
  }
}
