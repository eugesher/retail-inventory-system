import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { Repository } from 'typeorm';

import { IAuditLogAppendResult, IAuditLogRepositoryPort } from '../../application/ports';
import { AuditLogEntry } from '../../domain';
import { AuditLogEntryEntity } from './audit-log-entry.entity';
import { AuditLogEntryMapper } from './audit-log-entry.mapper';

// The single `@InjectRepository(AuditLogEntryEntity)` site. It implements
// `IAuditLogRepositoryPort` DIRECTLY — deliberately NOT extending
// `BaseTypeormRepository`, whose public `save` / `softDelete` would contradict the
// append-only audit trail (ADR-035). The only mutating verb is `append`, which uses
// `insert`; there is no UPDATE or DELETE expression at the persistence layer. Returns
// domain types only — no TypeORM leak past this file (ADR-017).
@Injectable()
export class AuditLogEntryTypeormRepository implements IAuditLogRepositoryPort {
  constructor(
    @InjectRepository(AuditLogEntryEntity)
    private readonly auditLogRepository: Repository<AuditLogEntryEntity>,
  ) {}

  public async append(entry: AuditLogEntry): Promise<IAuditLogAppendResult> {
    // INSERT, not `save`: an audit entry is born with a null id and is never updated.
    // Audit has no natural dedupe key (two identical staff actions are two real events),
    // so there is no UNIQUE to collide on — every insert is a fresh autoincrement row.
    const partial = AuditLogEntryMapper.toEntity(entry);
    // The cast bridges the mapper's `DeepPartial` to `insert`'s `QueryDeepPartialEntity`
    // — they coincide for scalar columns but diverge on the JSON `before` / `after`
    // snapshots; the mapper already produced a concrete, well-formed row.
    await this.auditLogRepository.insert(partial as QueryDeepPartialEntity<AuditLogEntryEntity>);
    return { inserted: true };
  }

  public async listByActor(actorId: string): Promise<AuditLogEntry[]> {
    // Newest-first; the `id DESC` tiebreaker makes the order total when two rows share
    // an `occurred_at`. A read — the append-only invariant is untouched.
    const entities = await this.auditLogRepository.find({
      where: { actorId },
      order: { occurredAt: 'DESC', id: 'DESC' },
    });
    return entities.map((entity) => AuditLogEntryMapper.toDomain(entity));
  }
}
