import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';

import { IConsentReaderPort, IConsentSnapshot } from '../../application/ports';

interface IConsentRow {
  transactionalEmail: number;
  marketingEmail: number;
  marketingSms: number;
  dataRetentionPolicy: string;
}

@Injectable()
export class ConsentReaderTypeormAdapter implements IConsentReaderPort {
  constructor(
    @InjectEntityManager()
    private readonly entityManager: EntityManager,
  ) {}

  public async load(customerId: string): Promise<IConsentSnapshot | null> {
    const rows = await this.entityManager.query<IConsentRow[]>(
      `SELECT transactional_email AS transactionalEmail,
              marketing_email      AS marketingEmail,
              marketing_sms        AS marketingSms,
              data_retention_policy AS dataRetentionPolicy
         FROM consent_record
        WHERE customer_id = ?`,
      [customerId],
    );
    if (rows.length === 0) {
      return null;
    }
    const [row] = rows;

    return {
      transactionalEmail: row.transactionalEmail === 1,
      marketingEmail: row.marketingEmail === 1,
      marketingSms: row.marketingSms === 1,
      dataRetentionPolicy: row.dataRetentionPolicy,
    };
  }
}
