import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { Between, FindOptionsWhere, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';

import { IAuditLogQueryFilters, IPage } from '@retail-inventory-system/contracts';

import { IAuditLogPageRequest, IAuditLogRepositoryPort } from '../../application/ports';
import { AuditLogEntry } from '../../domain';
import { AuditLogEntryEntity } from './audit-log-entry.entity';
import { AuditLogEntryMapper } from './audit-log-entry.mapper';
import { parseInstant } from './parse-instant';

@Injectable()
export class AuditLogEntryTypeormRepository implements IAuditLogRepositoryPort {
  constructor(
    @InjectRepository(AuditLogEntryEntity)
    private readonly auditLogRepository: Repository<AuditLogEntryEntity>,
  ) {}

  public async append(entry: AuditLogEntry): Promise<void> {
    const partial = AuditLogEntryMapper.toEntity(entry);
    await this.auditLogRepository.insert(partial as QueryDeepPartialEntity<AuditLogEntryEntity>);
  }

  public async query(
    filters: IAuditLogQueryFilters,
    page: IAuditLogPageRequest,
  ): Promise<IPage<AuditLogEntry>> {
    const where: FindOptionsWhere<AuditLogEntryEntity> = {};
    if (filters.actorId !== undefined) {
      where.actorId = filters.actorId;
    }
    if (filters.entityType !== undefined) {
      where.entityType = filters.entityType;
    }
    if (filters.entityId !== undefined) {
      where.entityId = filters.entityId;
    }
    if (filters.action !== undefined) {
      where.action = filters.action;
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

    const [entities, total] = await this.auditLogRepository.findAndCount({
      where,
      order: { occurredAt: 'DESC', id: 'DESC' },
      skip: (page.page - 1) * page.size,
      take: page.size,
    });

    return {
      items: entities.map((entity) => AuditLogEntryMapper.toDomain(entity)),
      total,
      page: page.page,
      size: page.size,
    };
  }

  public async listByCorrelationId(correlationId: string): Promise<AuditLogEntry[]> {
    const entities = await this.auditLogRepository.find({
      where: { correlationId },
      order: { occurredAt: 'ASC', id: 'ASC' },
    });
    return entities.map((entity) => AuditLogEntryMapper.toDomain(entity));
  }
}
