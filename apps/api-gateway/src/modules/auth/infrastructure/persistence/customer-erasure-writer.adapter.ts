import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';

import { ICustomerErasureWriterPort } from '../../application/ports';
import { Customer } from '../../domain';
import { CustomerEntity } from './customer.entity';
import { CustomerMapper } from './customer.mapper';

// The `CUSTOMER_ERASURE_WRITER` binding (ADR-037 §3). It nulls a customer's PII
// across the two bounded contexts that hold it — the gateway-owned `customer`
// table and the retail-owned `address` / `cart` tables — inside **one**
// `manager.transaction(...)`, so the erase is atomic and centralized at a single
// auditable site.
//
// The `customer` row is the auth module's own aggregate, so it is persisted through
// the module's `CustomerMapper` + the transactional repository (the mapper stays the
// single source of truth for the column mapping). The `address` / `cart` tables belong
// to the retail `orders` / `cart` modules behind a hard isolation line — the boundaries
// lint forbids importing their entities (ADR-017) — so this adapter reaches them with
// PARAMETERIZED SQL through the injected `EntityManager`, exactly as `CartReaderTypeormAdapter`
// reaches the `cart` tables from the orders context. The opaque shared FKs
// (`address.owner_id` / `cart.customer_id` → `customer.id`) are the only coupling; the
// `?` placeholders are bound by the driver, never string-concatenated.
@Injectable()
export class CustomerErasureWriterAdapter implements ICustomerErasureWriterPort {
  constructor(
    @InjectEntityManager()
    private readonly entityManager: EntityManager,
  ) {}

  public async persistErasure(customer: Customer): Promise<void> {
    await this.entityManager.transaction(async (manager: EntityManager) => {
      // 1. The erased customer row — null PII, `status='deleted'`, `deleted_at`,
      //    null `refresh_token_hash`. The mapper carries the already-nulled fields.
      await manager.getRepository(CustomerEntity).save(CustomerMapper.toEntity(customer));

      // 2. The customer's reusable address-book rows (`owner_type='customer'`).
      //    Null every PII column while keeping `country` (a non-identifying region
      //    code). **Never** touches `owner_type='order'` rows — those are immutable
      //    place-time snapshots of where an order shipped, part of the sales history
      //    (ADR-028 §5). There are zero such rows today (no address-book write path
      //    exists yet); this is the future-proof correct behavior.
      await manager.query(
        `UPDATE address
            SET recipient_name = NULL,
                line1 = NULL,
                line2 = NULL,
                city = NULL,
                region = NULL,
                postal_code = NULL,
                phone = NULL,
                updated_at = CURRENT_TIMESTAMP
          WHERE owner_type = ? AND owner_id = ?`,
        ['customer', customer.id],
      );

      // 3. Abandon the customer's active carts (Q1) — a `Cart` is a disposable
      //    working set, not a record to preserve. The FK is left intact (not nulled)
      //    so the tombstone customer row still resolves. `version = version + 1`
      //    keeps the cart's optimistic-concurrency token advancing on the mutation,
      //    the `CartReaderTypeormAdapter.markConverted` precedent (ADR-028 §6).
      await manager.query(
        `UPDATE cart
            SET status = 'abandoned', version = version + 1, updated_at = CURRENT_TIMESTAMP
          WHERE customer_id = ? AND status = 'active'`,
        [customer.id],
      );
    });
  }
}
