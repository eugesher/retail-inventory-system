import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';

import { IOrderCustomerContact, IOrderCustomerContactReaderPort } from '../../application/ports';

// The mysql2 row shape for the single customer read. `email` is selected straight (no
// snake_case → camelCase aliasing needed for a one-column projection); the column is
// VARCHAR, so it surfaces as a string (or null on a future tombstone).
interface ICustomerContactRow {
  email: string | null;
}

// The orders context's read seam onto the gateway-owned **customer** table. The `customer`
// aggregate lives in the API gateway behind a hard isolation line — the boundaries lint
// forbids the orders module from importing the gateway's `CustomerEntity` (ADR-017). So this
// adapter reaches `customer` with PARAMETERIZED SQL through the injected `EntityManager`,
// exactly as `CartReaderTypeormAdapter` reaches the cart tables (ADR-028) and pricing reaches
// the catalog-owned `product_variant.tax_category_id` (ADR-026 §5). The opaque shared FK
// (`order.customer_id` → `customer.id`) is the only coupling; the `?` placeholder is bound by
// the driver, never string-concatenated.
//
// `customer` is not a SQL reserved word, so no backticks. The table carries no `deleted_at`
// (the gateway customer is tombstoned in place via its `status` enum, not soft-deleted), so
// the read has no `deleted_at IS NULL` filter — a resolvable id returns its contact even for
// a `suspended`/`deleted` row, which is correct: the email is still where a final
// notification would go.
@Injectable()
export class CustomerContactReaderTypeormAdapter implements IOrderCustomerContactReaderPort {
  constructor(
    @InjectEntityManager()
    private readonly entityManager: EntityManager,
  ) {}

  public async findContactByCustomerId(customerId: string): Promise<IOrderCustomerContact | null> {
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
