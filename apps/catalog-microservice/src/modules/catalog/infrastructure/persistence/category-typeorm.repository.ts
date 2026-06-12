import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DeepPartial, FindOptionsWhere, IsNull, Repository } from 'typeorm';

import { BaseTypeormRepository } from '@retail-inventory-system/database';

import { Category, CategoryStatusEnum } from '../../domain';
import {
  ICategoryListAllOptions,
  ICategoryRepositoryPort,
  ICategorySubtreeOptions,
} from '../../application/ports';
import { CategoryEntity } from './category.entity';
import { CategoryMapper } from './category.mapper';

// mysql2 returns an UPDATE result as a ResultSetHeader; `affectedRows` is the
// descendant-rewrite count `reparentSubtree` surfaces. Typed locally so the
// `manager.query<...>` result stays off `any` without an assertion (ADR-017's
// no-unsafe-* rules).
interface IResultSetHeader {
  affectedRows: number;
}

// The single `InjectRepository` site for the Category aggregate. Extends
// `BaseTypeormRepository` for the `toDomain`/`toEntity` seam; `save` re-reads for
// the concrete id, and `reparentSubtree` runs its own `manager.transaction`
// (the `PricingTypeormRepository.appendPrice` precedent — the transaction lives
// inside the repository method, no `ITransactionPort` needed; ADR-019 / ADR-029).
@Injectable()
export class CategoryTypeormRepository
  extends BaseTypeormRepository<CategoryEntity, Category>
  implements ICategoryRepositoryPort
{
  constructor(
    @InjectRepository(CategoryEntity)
    private readonly categoryRepository: Repository<CategoryEntity>,
    @InjectPinoLogger(CategoryTypeormRepository.name)
    private readonly logger: PinoLogger,
  ) {
    super(categoryRepository);
  }

  protected toDomain(entity: CategoryEntity): Category {
    return CategoryMapper.toDomain(entity);
  }

  protected toEntity(domain: Category): DeepPartial<CategoryEntity> {
    return CategoryMapper.toEntity(domain);
  }

  public async save(category: Category): Promise<Category> {
    const saved = await this.categoryRepository.save(CategoryMapper.toEntity(category));

    // Re-read so the returned aggregate carries the DB-assigned id and
    // timestamps. The row was just committed, so a miss here is an invariant
    // breach rather than a not-found.
    const reloaded = await this.findById(saved.id);
    if (!reloaded) {
      throw new Error(`CategoryTypeormRepository.save: category ${saved.id} vanished after commit`);
    }
    return reloaded;
  }

  public async findById(id: number): Promise<Category | null> {
    const entity = await this.categoryRepository.findOne({ where: { id } });
    return entity ? CategoryMapper.toDomain(entity) : null;
  }

  public async findBySlug(slug: string): Promise<Category | null> {
    const entity = await this.categoryRepository.findOne({ where: { slug } });
    return entity ? CategoryMapper.toDomain(entity) : null;
  }

  public existsBySlug(slug: string): Promise<boolean> {
    return this.categoryRepository.existsBy({ slug });
  }

  public async listAll(opts: ICategoryListAllOptions): Promise<Category[]> {
    const where: FindOptionsWhere<CategoryEntity> = {};
    if (opts.rootOnly) {
      where.parentId = IsNull();
    }
    if (opts.activeOnly) {
      where.status = CategoryStatusEnum.ACTIVE;
    }

    // `sortOrder ASC, name ASC` — the store-front navigation order for the flat
    // list read (`catalog.category.list`): an explicit merchandising sort first,
    // then name as the stable tiebreaker. (The tree read assembles its own
    // ordering from `listSubtree`; this ordering is the flat-list contract.)
    const entities = await this.categoryRepository.find({
      where,
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
    return entities.map((entity) => CategoryMapper.toDomain(entity));
  }

  public async listSubtree(
    pathPrefix: string,
    opts?: ICategorySubtreeOptions,
  ): Promise<Category[]> {
    // `path = :prefix` (self) OR `path LIKE :likePrefix` (strict descendants).
    // A valid path contains only kebab-case slugs and `/`, so it never carries a
    // LIKE wildcard (`%`/`_`) — the `:likePrefix` bind is safe without escaping.
    const builder = this.categoryRepository
      .createQueryBuilder('Category')
      .where('(Category.path = :prefix OR Category.path LIKE :likePrefix)', {
        prefix: pathPrefix,
        likePrefix: `${pathPrefix}/%`,
      });

    if (opts?.activeOnly) {
      builder.andWhere('Category.status = :status', { status: CategoryStatusEnum.ACTIVE });
    }

    const entities = await builder.orderBy('Category.path', 'ASC').getMany();
    return entities.map((entity) => CategoryMapper.toDomain(entity));
  }

  public async reparentSubtree(category: Category, oldPath: string): Promise<number> {
    if (category.id === null) {
      throw new Error('CategoryTypeormRepository.reparentSubtree: category has no id');
    }
    const newPath = category.path;
    const movedId = category.id;
    const newParentId = category.parentId;

    // A no-op move (reparenting under the CURRENT parent ⇒ the domain re-derives
    // the identical path) would rewrite the moved row AND every descendant to its
    // existing value — pure write amplification, plus a spurious `updated_at` bump
    // across the whole subtree. Nothing changed, so skip the transaction entirely
    // and report zero rebased descendants (the use case treats same-parent as an
    // idempotent success). `newPath === oldPath` implies the parent is unchanged
    // too, since a node's path uniquely identifies it, so the moved-row UPDATE is
    // equally a no-op.
    if (newPath === oldPath) {
      this.logger.debug(
        { categoryId: movedId, path: newPath },
        'Category reparent is a no-op (path unchanged); skipping subtree rebase',
      );
      return 0;
    }

    // One transaction for the moved-row UPDATE + the bulk descendant rebase: a
    // window where the parent moved but its descendants still carry the old path
    // prefix would leave the tree inconsistent. Both statements are PARAMETERIZED
    // — `?` placeholders bound by the driver, never string-interpolated (ADR-029).
    const descendantsRewritten = await this.categoryRepository.manager.transaction(
      async (manager) => {
        // 1. The moved row itself: write the already-recomputed parent_id + path.
        await manager.query('UPDATE category SET parent_id = ?, path = ? WHERE id = ?', [
          newParentId,
          newPath,
          movedId,
        ]);

        // 2. Every strict descendant: swap the old path prefix for the new one in
        //    a single bulk statement. `SUBSTRING(path, LENGTH(oldPath) + 1)` is
        //    the tail after the old prefix (e.g. `/phones`), re-prefixed with
        //    `newPath`. The `oldPath + '/%'` filter excludes the moved row (its
        //    path no longer starts with `oldPath/`).
        const result = await manager.query<IResultSetHeader>(
          'UPDATE category SET path = CONCAT(?, SUBSTRING(path, ? + 1)) WHERE path LIKE ?',
          [newPath, oldPath.length, `${oldPath}/%`],
        );

        return result.affectedRows;
      },
    );

    this.logger.debug(
      { categoryId: movedId, oldPath, newPath, descendantsRewritten },
      'Category subtree reparented',
    );

    return descendantsRewritten;
  }

  // --- product_categories N↔M membership (ADR-029 §3) -----------------------
  //
  // The join table is bare (composite PK `(product_id, category_id)`, no
  // surrogate id, NO entity), so it is maintained with PARAMETERIZED SQL through
  // the injected manager — never string-interpolated ids (the
  // `product_variant.tax_category_id` precedent, ADR-026 §5). Both writes are
  // idempotent so a retried reclassify RPC is safe.

  public async attachProductCategories(productId: number, categoryIds: number[]): Promise<void> {
    // An empty list is a no-op — and a guard against generating `VALUES ` with no
    // tuples, which is a SQL syntax error.
    if (categoryIds.length === 0) {
      return;
    }

    // One multi-row `INSERT IGNORE`: a `(?, ?)` tuple per id. `IGNORE` swallows a
    // duplicate-key collision on the composite PK, so re-attaching an existing
    // membership is a silent success (idempotent).
    const valuesClause = categoryIds.map(() => '(?, ?)').join(', ');
    const params = categoryIds.flatMap((categoryId) => [productId, categoryId]);
    await this.categoryRepository.manager.query(
      `INSERT IGNORE INTO product_categories (product_id, category_id) VALUES ${valuesClause}`,
      params,
    );
  }

  public async detachProductCategories(productId: number, categoryIds: number[]): Promise<void> {
    if (categoryIds.length === 0) {
      return;
    }

    // DELETE the named pairs; a pair that is not a membership matches no row
    // (idempotent silent no-op). A `?` placeholder per id in the IN list.
    const placeholders = categoryIds.map(() => '?').join(', ');
    await this.categoryRepository.manager.query(
      `DELETE FROM product_categories WHERE product_id = ? AND category_id IN (${placeholders})`,
      [productId, ...categoryIds],
    );
  }

  public async listCategoriesForProduct(productId: number): Promise<Category[]> {
    // Resolve the join to the `category` rows via a parameterized id-subselect
    // against the bare table — no need to join a non-entity table into the
    // builder. Hydrates `CategoryEntity` instances so the mapper coerces the
    // BIGINT `parent_id` as on every other read. Any status (the reclassify
    // response surfaces the full current membership, archived included).
    const entities = await this.categoryRepository
      .createQueryBuilder('Category')
      .where(
        'Category.id IN (SELECT pc.category_id FROM product_categories pc WHERE pc.product_id = :productId)',
        { productId },
      )
      .orderBy('Category.path', 'ASC')
      .getMany();

    return entities.map((entity) => CategoryMapper.toDomain(entity));
  }
}
