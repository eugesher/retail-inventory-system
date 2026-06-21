import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';

import { IReturnCustomerContact, IReturnCustomerContactReaderPort } from '../../application/ports';

// The mysql2 row shape for the single customer read. `email` is selected straight (no
// snake_case → camelCase aliasing needed for a one-column projection); the column is
// VARCHAR, so it surfaces as a string (or null on a future tombstone).
interface ICustomerContactRow {
  email: string | null;
}

// The returns context's read seam onto the gateway-owned **customer** table — a local copy
// of the orders module's adapter (returns cannot import the orders module across the
// boundaries-lint isolation line, ADR-017, so the one-place-per-module posture is duplicated
// rather than shared, the `retry-then-log-for-replay` precedent). It reads `customer` with
// PARAMETERIZED SQL through the injected `EntityManager`, exactly as
// `ReturnOrderReaderTypeormAdapter` reaches the order tables. The opaque shared FK
// (`return_request.customer_id` → `customer.id`) is the only coupling; the `?` placeholder is
// bound by the driver, never string-concatenated.
//
// `customer` is not a SQL reserved word, so no backticks. The table carries no `deleted_at`
// (the gateway customer is tombstoned in place via its `status` enum, not soft-deleted), so
// the read has no `deleted_at IS NULL` filter.
@Injectable()
export class CustomerContactReaderTypeormAdapter implements IReturnCustomerContactReaderPort {
  constructor(
    @InjectEntityManager()
    private readonly entityManager: EntityManager,
  ) {}

  public async findContactByCustomerId(customerId: string): Promise<IReturnCustomerContact | null> {
    const rows = await this.entityManager.query<ICustomerContactRow[]>(
      'SELECT email FROM customer WHERE id = ?',
      [customerId],
    );
    if (rows.length === 0) {
      return null;
    }
    return { email: rows[0].email ?? null };
  }
}
