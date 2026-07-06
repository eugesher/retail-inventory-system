import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { IConsentRecordRepositoryPort } from '../../application/ports';
import { ConsentRecord } from '../../domain';
import { ConsentRecordEntity } from './consent-record.entity';
import { ConsentRecordMapper } from './consent-record.mapper';

// The sole `@InjectRepository(ConsentRecordEntity)` site. It implements
// `IConsentRecordRepositoryPort` directly (not `BaseTypeormRepository`, whose
// numeric-id assumptions and soft-delete surface don't fit a CHAR(36)-keyed,
// no-`BaseEntity` row) and returns domain types only — no TypeORM leak past this
// file (ADR-017). The `CustomerTypeormRepository` "save-then-reload" precedent.
@Injectable()
export class ConsentRecordTypeormRepository implements IConsentRecordRepositoryPort {
  constructor(
    @InjectRepository(ConsentRecordEntity)
    private readonly repository: Repository<ConsentRecordEntity>,
  ) {}

  public async findByCustomerId(customerId: string): Promise<ConsentRecord | null> {
    const entity = await this.repository.findOne({ where: { customerId } });
    return entity ? ConsentRecordMapper.toDomain(entity) : null;
  }

  // INSERT-or-update upsert on the `customer_id` PK: TypeORM `.save` INSERTs a new
  // row on first write and UPDATEs the flags/policy on subsequent writes; the
  // `@UpdateDateColumn` `updated_at` is DB-stamped. Re-read so the returned record
  // carries the persisted `updatedAt`.
  public async save(record: ConsentRecord): Promise<ConsentRecord> {
    const partial = ConsentRecordMapper.toEntity(record);
    await this.repository.save(partial);
    const reloaded = await this.repository.findOne({ where: { customerId: record.customerId } });
    if (!reloaded) {
      throw new Error(
        `ConsentRecordTypeormRepository.save: lost row customerId=${record.customerId} after upsert`,
      );
    }
    return ConsentRecordMapper.toDomain(reloaded);
  }
}
