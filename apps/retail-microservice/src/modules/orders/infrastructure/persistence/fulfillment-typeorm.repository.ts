import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, EntityManager, Repository } from 'typeorm';

import { BaseTypeormRepository, entityManagerOf } from '@retail-inventory-system/database';

import { Fulfillment } from '../../domain';
import { IFulfillmentRepositoryPort, ITransactionScope } from '../../application/ports';
import { FulfillmentEntity } from './fulfillment.entity';
import { FulfillmentLineEntity } from './fulfillment-line.entity';
import { FulfillmentLineMapper } from './fulfillment-line.mapper';
import { FulfillmentMapper } from './fulfillment.mapper';

@Injectable()
export class FulfillmentTypeormRepository
  extends BaseTypeormRepository<FulfillmentEntity, Fulfillment>
  implements IFulfillmentRepositoryPort
{
  constructor(
    @InjectRepository(FulfillmentEntity)
    private readonly fulfillmentRepository: Repository<FulfillmentEntity>,
    @InjectRepository(FulfillmentLineEntity)
    private readonly fulfillmentLineRepository: Repository<FulfillmentLineEntity>,
  ) {
    super(fulfillmentRepository);
  }

  protected toDomain(entity: FulfillmentEntity): Fulfillment {
    return FulfillmentMapper.toDomain(entity);
  }

  protected toEntity(domain: Fulfillment): DeepPartial<FulfillmentEntity> {
    return FulfillmentMapper.toEntity(domain);
  }

  public async save(fulfillment: Fulfillment, scope?: ITransactionScope): Promise<Fulfillment> {
    let id: number;
    if (scope) {
      id = await this.persistGraph(entityManagerOf(scope), fulfillment);
    } else {
      id = await this.fulfillmentRepository.manager.transaction((manager) =>
        this.persistGraph(manager, fulfillment),
      );
    }

    const reloaded = await this.findById(id, scope);
    if (!reloaded) {
      throw new Error(`FulfillmentTypeormRepository.save: fulfillment ${id} vanished after commit`);
    }
    return reloaded;
  }

  public async findById(id: number, scope?: ITransactionScope): Promise<Fulfillment | null> {
    const entity = await this.fulfillmentRepo(scope).findOne({
      where: { id },
      relations: { lines: true },
      order: { lines: { id: 'ASC' } },
    });
    return entity ? FulfillmentMapper.toDomain(entity) : null;
  }

  public async findByIdForUpdate(
    id: number,
    scope: ITransactionScope,
  ): Promise<Fulfillment | null> {
    const entity = await this.fulfillmentRepo(scope)
      .createQueryBuilder('fulfillment')
      .setLock('pessimistic_write')
      .leftJoinAndSelect('fulfillment.lines', 'lines')
      .where('fulfillment.id = :id', { id })
      .getOne();
    return entity ? FulfillmentMapper.toDomain(entity) : null;
  }

  public async listByOrderId(orderId: number, scope?: ITransactionScope): Promise<Fulfillment[]> {
    const entities = await this.fulfillmentRepo(scope).find({
      where: { orderId },
      relations: { lines: true },
      order: { shippedAt: 'DESC', id: 'DESC', lines: { id: 'ASC' } },
    });
    return entities.map((entity) => FulfillmentMapper.toDomain(entity));
  }

  private async persistGraph(manager: EntityManager, fulfillment: Fulfillment): Promise<number> {
    const fulfillmentRepo = manager.getRepository(FulfillmentEntity);
    const lineRepo = manager.getRepository(FulfillmentLineEntity);

    if (fulfillment.id === null) {
      const inserted = await fulfillmentRepo.save(FulfillmentMapper.toEntity(fulfillment));
      const newId = Number(inserted.id);
      await this.persistLines(lineRepo, fulfillment, newId);
      return newId;
    }

    const existingId = fulfillment.id;
    await fulfillmentRepo.save({ ...FulfillmentMapper.toEntity(fulfillment), id: existingId });
    return existingId;
  }

  private async persistLines(
    lineRepo: Repository<FulfillmentLineEntity>,
    fulfillment: Fulfillment,
    fulfillmentId: number,
  ): Promise<void> {
    const lineEntities = fulfillment.lines.map((line) =>
      FulfillmentLineMapper.toEntity(line, fulfillmentId),
    );
    if (lineEntities.length > 0) {
      await lineRepo.save(lineEntities);
    }
  }

  private fulfillmentRepo(scope?: ITransactionScope): Repository<FulfillmentEntity> {
    if (!scope) {
      return this.fulfillmentRepository;
    }
    return entityManagerOf(scope).getRepository(FulfillmentEntity);
  }
}
