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
