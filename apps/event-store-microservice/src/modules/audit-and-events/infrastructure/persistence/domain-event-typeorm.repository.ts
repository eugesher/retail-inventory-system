import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { Between, FindOptionsWhere, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';

import { IDomainEventQueryFilters, IPage } from '@retail-inventory-system/contracts';

import {
  IDomainEventAppendResult,
  IDomainEventPageRequest,
  IDomainEventRepositoryPort,
} from '../../application/ports';
import { DomainEvent } from '../../domain';
import { DomainEventEntity } from './domain-event.entity';
import { DomainEventMapper } from './domain-event.mapper';
import { parseInstant } from './parse-instant';

const MYSQL_ER_DUP_ENTRY_ERRNO = 1062;
const MYSQL_ER_DUP_ENTRY_CODE = 'ER_DUP_ENTRY';

function isDuplicateEntryError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as {
    errno?: number;
    code?: string;
    driverError?: { errno?: number; code?: string };
  };
  const driver = candidate.driverError ?? candidate;
  return driver.errno === MYSQL_ER_DUP_ENTRY_ERRNO || driver.code === MYSQL_ER_DUP_ENTRY_CODE;
}

@Injectable()
export class DomainEventTypeormRepository implements IDomainEventRepositoryPort {
  constructor(
    @InjectRepository(DomainEventEntity)
    private readonly domainEventRepository: Repository<DomainEventEntity>,
  ) {}

  public async append(event: DomainEvent): Promise<IDomainEventAppendResult> {
    const partial = DomainEventMapper.toEntity(event);

    try {
      await this.domainEventRepository.insert(partial as QueryDeepPartialEntity<DomainEventEntity>);
      return { inserted: true };
    } catch (error) {
      if (isDuplicateEntryError(error)) {
        return { inserted: false };
      }
      throw error;
    }
  }

  public async query(
    filters: IDomainEventQueryFilters,
    page: IDomainEventPageRequest,
  ): Promise<IPage<DomainEvent>> {
    const where: FindOptionsWhere<DomainEventEntity> = {};
    if (filters.eventType !== undefined) {
      where.eventType = filters.eventType;
    }
    if (filters.aggregateType !== undefined) {
      where.aggregateType = filters.aggregateType;
    }
    if (filters.aggregateId !== undefined) {
      where.aggregateId = filters.aggregateId;
    }
    if (filters.correlationId !== undefined) {
      where.correlationId = filters.correlationId;
    }

    const from = parseInstant(filters.from);
    const to = parseInstant(filters.to);
    if (from !== undefined && to !== undefined) {
      where.occurredAt = Between(from, to);
    } else if (from !== undefined) {
      where.occurredAt = MoreThanOrEqual(from);
    } else if (to !== undefined) {
      where.occurredAt = LessThanOrEqual(to);
    }

    const [entities, total] = await this.domainEventRepository.findAndCount({
      where,
      order: { occurredAt: 'DESC', id: 'DESC' },
      skip: (page.page - 1) * page.size,
      take: page.size,
    });

    return {
      items: entities.map((entity) => DomainEventMapper.toDomain(entity)),
      total,
      page: page.page,
      size: page.size,
    };
  }

  public async listByCorrelationId(correlationId: string): Promise<DomainEvent[]> {
    const entities = await this.domainEventRepository.find({
      where: { correlationId },
      order: { occurredAt: 'ASC', id: 'ASC' },
    });
    return entities.map((entity) => DomainEventMapper.toDomain(entity));
  }
}
