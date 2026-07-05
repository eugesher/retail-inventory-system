import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';

import { IConsentReaderPort, IConsentSnapshot } from '../../application/ports';

// The mysql2 row shape for the consent read. Aliasing the snake_case columns to
// camelCase keeps the projection mapping off `any` without an assertion (ADR-017's
// no-unsafe-* rules). The three consent flags are `TINYINT(1)` columns — mysql2
// surfaces those as `0`/`1` numbers, so the mapper coerces each to a boolean.
interface IConsentRow {
  transactionalEmail: number;
  marketingEmail: number;
  marketingSms: number;
  dataRetentionPolicy: string;
}

// The notification context's read seam onto the **gateway-owned** `consent_record`
// table. The `consent_record` aggregate lives in the api-gateway `auth` module, behind
// a hard cross-context isolation line — the boundaries lint forbids the notification
// service from importing the gateway's `ConsentRecordEntity` (ADR-017). So this adapter
// reaches the shared-`retail_db` table with PARAMETERIZED SQL through the injected
// `EntityManager`, exactly as the retail `CartReaderTypeormAdapter` reaches the cart
// tables (ADR-026 §5). The opaque shared key (`consent_record.customer_id`, the
// customer's CHAR(36) UUID) is the only coupling; the `?` placeholder is bound by the
// driver, never string-concatenated.
//
// `consent_record` has NO `deleted_at` (it is a `BaseEntity`-free 1:1 table, ADR-037),
// so — unlike the cart reader — there is no soft-delete filter to add.
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
