import { InventoryAutoInitE2ESpecDataSource } from './inventory-auto-init.e2e-spec.data-source';

// One `customer` row, projected to the columns the erase suites assert on. The
// gateway exposes no admin "read customer" endpoint, so the tombstone oracle reads
// the row directly: after an erase the PII columns must be NULL, `status` must be
// `deleted`, `deleted_at` must be set, and `refresh_token_hash` must be NULL — none
// of which any public response surfaces.
export interface ICustomerRowProjection {
  id: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  passwordHash: string | null;
  status: string;
  refreshTokenHash: string | null;
  deletedAt: Date | null;
}

// One `address` row, projected to the PII columns. The tombstone suite reads the
// order's snapshot addresses (`owner_type = 'order'`) to prove they are UNTOUCHED by
// the erase — the erasure writer nulls only `owner_type = 'customer'` PII, and an
// order snapshot is immutable (ADR-028), so an order placed before the erase keeps a
// complete shipping/billing record.
export interface IAddressRowProjection {
  id: string;
  ownerType: string;
  ownerId: string;
  recipientName: string | null;
  line1: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string;
}

// One `cart` row, projected to the columns the tombstone suite asserts on: the erase
// abandons every ACTIVE cart the customer owns, so the suite checks that a cart left
// active before the erase is `abandoned` afterwards (and that a `converted` cart — the
// one the placed order consumed — is left alone).
export interface ICartRowProjection {
  id: string;
  status: string;
}

// One `consent_record` row, projected to the flags the erase suite asserts on. The
// tombstone suite opts the customer into marketing (creating the row), then proves the
// erase DELETES it — so a later consent read falls through to the absent-row defaults
// (marketing denied) and the consent-gate can never send marketing to an erased
// customer. mysql2 surfaces the `TINYINT(1)` flags as `0`/`1` numbers, coerced here.
export interface IConsentRowProjection {
  customerId: string;
  transactionalEmail: boolean;
  marketingEmail: boolean;
  marketingSms: boolean;
  dataRetentionPolicy: string;
}

// E2E helper for the consent/erasure suites. Inherits `getStockLevelRows` (the
// tombstone suite polls it for the async catalog-variant-created auto-init before
// receiving stock, exactly as the order/fulfillment suites do) and adds read-only
// projections over the gateway-owned `customer` table and the retail `address` / `cart`
// tables — the tables an erase mutates, none of which the API exposes for a direct read.
//
// mysql2 returns TIMESTAMP columns as JS `Date`s (the driver is pinned to UTC) and
// everything else as strings; the projections coerce only where a suite needs a
// non-string ergonomics (the `deleted_at` Date is passed through for a truthiness check).
export class ConsentErasureE2ESpecDataSource extends InventoryAutoInitE2ESpecDataSource {
  public async getCustomerById(id: string): Promise<ICustomerRowProjection | undefined> {
    const rows: Record<string, unknown>[] = await this.query(
      `
        SELECT id, email, phone, first_name, last_name, password_hash, status,
               refresh_token_hash, deleted_at
        FROM customer
        WHERE id = ?
        LIMIT 1;
      `,
      [id],
    );
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return {
      id: String(row.id),
      email: (row.email as string | null) ?? null,
      phone: (row.phone as string | null) ?? null,
      firstName: (row.first_name as string | null) ?? null,
      lastName: (row.last_name as string | null) ?? null,
      passwordHash: (row.password_hash as string | null) ?? null,
      status: String(row.status),
      refreshTokenHash: (row.refresh_token_hash as string | null) ?? null,
      deletedAt: (row.deleted_at as Date | null) ?? null,
    };
  }

  public async getAddressesByOwner(
    ownerType: string,
    ownerId: string,
  ): Promise<IAddressRowProjection[]> {
    const rows: Record<string, unknown>[] = await this.query(
      `
        SELECT id, owner_type, owner_id, recipient_name, line1, city, region,
               postal_code, country
        FROM address
        WHERE owner_type = ? AND owner_id = ?
        ORDER BY id;
      `,
      [ownerType, ownerId],
    );
    return rows.map((row) => ({
      id: String(row.id),
      ownerType: String(row.owner_type),
      ownerId: String(row.owner_id),
      recipientName: (row.recipient_name as string | null) ?? null,
      line1: (row.line1 as string | null) ?? null,
      city: (row.city as string | null) ?? null,
      region: (row.region as string | null) ?? null,
      postalCode: (row.postal_code as string | null) ?? null,
      country: String(row.country),
    }));
  }

  public async getCartsByCustomerId(customerId: string): Promise<ICartRowProjection[]> {
    const rows: Record<string, unknown>[] = await this.query(
      `
        SELECT id, status
        FROM cart
        WHERE customer_id = ?
        ORDER BY id;
      `,
      [customerId],
    );
    return rows.map((row) => ({
      id: String(row.id),
      status: String(row.status),
    }));
  }

  // Reads the customer's `consent_record` row (the erase must DELETE it). Returns
  // `undefined` when the row is absent — which, post-erase, is exactly the oracle: the
  // row is gone, so a consent read resolves to the absent-row defaults (marketing denied).
  public async getConsentByCustomerId(
    customerId: string,
  ): Promise<IConsentRowProjection | undefined> {
    const rows: Record<string, unknown>[] = await this.query(
      `
        SELECT customer_id, transactional_email, marketing_email, marketing_sms,
               data_retention_policy
        FROM consent_record
        WHERE customer_id = ?
        LIMIT 1;
      `,
      [customerId],
    );
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return {
      customerId: String(row.customer_id),
      // mysql2 surfaces a TINYINT(1) as a 0/1 number on a raw query.
      transactionalEmail: Number(row.transactional_email) === 1,
      marketingEmail: Number(row.marketing_email) === 1,
      marketingSms: Number(row.marketing_sms) === 1,
      dataRetentionPolicy: String(row.data_retention_policy),
    };
  }
}
