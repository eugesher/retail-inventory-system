import { DeepPartial } from 'typeorm';

import { ConsentRecord } from '../../domain';
import { ConsentRecordEntity } from './consent-record.entity';

export class ConsentRecordMapper {
  public static toDomain(entity: ConsentRecordEntity): ConsentRecord {
    return ConsentRecord.rehydrate(entity.customerId, {
      transactionalEmail: entity.transactionalEmail,
      marketingEmail: entity.marketingEmail,
      marketingSms: entity.marketingSms,
      dataRetentionPolicy: entity.dataRetentionPolicy,
      updatedAt: entity.updatedAt,
    });
  }

  // `updatedAt` is intentionally omitted — it is the DB's `@UpdateDateColumn`,
  // stamped by MySQL on write, never supplied by the application.
  public static toEntity(record: ConsentRecord): DeepPartial<ConsentRecordEntity> {
    return {
      customerId: record.customerId,
      transactionalEmail: record.transactionalEmail,
      marketingEmail: record.marketingEmail,
      marketingSms: record.marketingSms,
      dataRetentionPolicy: record.dataRetentionPolicy,
    };
  }
}
