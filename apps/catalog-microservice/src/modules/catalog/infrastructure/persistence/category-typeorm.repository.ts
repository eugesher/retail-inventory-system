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

interface IResultSetHeader {
  affectedRows: number;
}

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

    const reloaded = await this.findById(saved.id);
    if (!reloaded) {
      throw new Error(`CategoryTypeormRepository.save: category ${saved.id} vanished after commit`);
    }
    return reloaded;
  }

  private async findById(id: number): Promise<Category | null> {
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

    if (newPath === oldPath) {
      this.logger.debug(
        { categoryId: movedId, path: newPath },
        'Category reparent is a no-op (path unchanged); skipping subtree rebase',
      );
      return 0;
    }

    const descendantsRewritten = await this.categoryRepository.manager.transaction(
      async (manager) => {
        await manager.query('UPDATE category SET parent_id = ?, path = ? WHERE id = ?', [
          newParentId,
          newPath,
          movedId,
        ]);

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

  public async attachProductCategories(productId: number, categoryIds: number[]): Promise<void> {
    if (categoryIds.length === 0) {
      return;
    }

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

    const placeholders = categoryIds.map(() => '?').join(', ');
    await this.categoryRepository.manager.query(
      `DELETE FROM product_categories WHERE product_id = ? AND category_id IN (${placeholders})`,
      [productId, ...categoryIds],
    );
  }

  public async listCategoriesForProduct(productId: number): Promise<Category[]> {
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
