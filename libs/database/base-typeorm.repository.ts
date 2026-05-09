import { DeepPartial, FindOptionsWhere, ObjectLiteral, Repository } from 'typeorm';

export abstract class BaseTypeormRepository<TEntity extends ObjectLiteral, TDomain> {
  protected constructor(protected readonly repository: Repository<TEntity>) {}

  protected abstract toDomain(entity: TEntity): TDomain;

  protected abstract toEntity(domain: TDomain): DeepPartial<TEntity>;

  public async find(
    where: FindOptionsWhere<TEntity> | FindOptionsWhere<TEntity>[],
  ): Promise<TDomain[]> {
    const entities = await this.repository.find({ where });
    return entities.map((entity) => this.toDomain(entity));
  }

  public async save(domain: TDomain): Promise<TDomain> {
    const partial = this.toEntity(domain);
    const saved = await this.repository.save(partial);
    return this.toDomain(saved as TEntity);
  }

  public async softDelete(where: FindOptionsWhere<TEntity>): Promise<void> {
    await this.repository.softDelete(where);
  }
}
