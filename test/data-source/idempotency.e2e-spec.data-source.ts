import { InventoryAutoInitE2ESpecDataSource } from './inventory-auto-init.e2e-spec.data-source';

// One `idempotency_key` row, projected to the fields the purge suite asserts on. The
// store never exposes a read endpoint (ADR-036 keeps it an internal request-level
// dedupe surface), so the suite reads the row straight from the table to prove the TTL
// sweep removed exactly the aged rows and left the fresh ones.
export interface IIdempotencyKeyRowProjection {
  scope: string;
  key: string;
  expiresAt: Date;
}

// E2E helper for the idempotency / purge suites. Inherits `getStockLevelRows` (used to
// poll for the async catalog-variant-created auto-init before a cache-aside HTTP stock
// read, exactly as the fulfillment/refund suites do) and adds:
//   - `countOrdersBySourceCartId` — the "exactly one Order per logical place" proof
//     (a replay must not create a second order row for the same converted cart), and
//   - direct `idempotency_key` CRUD so the purge suite can seed an aged row, invoke the
//     purge use case with an explicit `now`, and assert the row was deleted while a
//     not-yet-expired control row survives.
//
// mysql2 returns BIGINT columns as strings and `timestamp` columns as `Date`s, so the
// order count is coerced with `Number(...)` and `expires_at` is passed through as a Date.
export class IdempotencyE2ESpecDataSource extends InventoryAutoInitE2ESpecDataSource {
  public async countOrdersBySourceCartId(cartId: string): Promise<number> {
    const rows: Record<string, unknown>[] = await this.query(
      `SELECT COUNT(*) AS n FROM \`order\` WHERE source_cart_id = ?;`,
      [cartId],
    );
    return Number(rows[0].n);
  }

  // Insert one `idempotency_key` row with an explicit `expires_at` — the purge suite's
  // aged/control fixtures. `response_body` is `JSON NOT NULL`, so a minimal `{}` is
  // stored. Idempotent by the composite PK `(scope, key)`: a re-run overwrites the same
  // row via `ON DUPLICATE KEY UPDATE`, so `yarn test:e2e` re-runs never collide.
  public async insertIdempotencyKey(row: {
    scope: string;
    key: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.query(
      `
        INSERT INTO idempotency_key
          (scope, \`key\`, request_fingerprint, response_status, response_body, expires_at)
        VALUES (?, ?, ?, ?, JSON_OBJECT(), ?)
        ON DUPLICATE KEY UPDATE expires_at = VALUES(expires_at);
      `,
      [row.scope, row.key, '0'.repeat(64), 200, row.expiresAt],
    );
  }

  public async getIdempotencyKey(
    scope: string,
    key: string,
  ): Promise<IIdempotencyKeyRowProjection | undefined> {
    const rows: Record<string, unknown>[] = await this.query(
      `SELECT scope, \`key\`, expires_at FROM idempotency_key WHERE scope = ? AND \`key\` = ? LIMIT 1;`,
      [scope, key],
    );
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return {
      scope: String(row.scope),
      key: String(row.key),
      expiresAt: row.expires_at as Date,
    };
  }

  public async countIdempotencyKeysByScope(scope: string): Promise<number> {
    const rows: Record<string, unknown>[] = await this.query(
      `SELECT COUNT(*) AS n FROM idempotency_key WHERE scope = ?;`,
      [scope],
    );
    return Number(rows[0].n);
  }

  // Cleanup seam so the purge suite starts from a known-empty scope on every run.
  public async deleteIdempotencyKeysByScope(scope: string): Promise<void> {
    await this.query(`DELETE FROM idempotency_key WHERE scope = ?;`, [scope]);
  }
}
