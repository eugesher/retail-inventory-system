import { InventoryAutoInitE2ESpecDataSource } from './inventory-auto-init.e2e-spec.data-source';

export interface IIdempotencyKeyRowProjection {
  scope: string;
  key: string;
  expiresAt: Date;
}

export class IdempotencyE2ESpecDataSource extends InventoryAutoInitE2ESpecDataSource {
  public async countOrdersBySourceCartId(cartId: string): Promise<number> {
    const rows: Record<string, unknown>[] = await this.query(
      `SELECT COUNT(*) AS n FROM \`order\` WHERE source_cart_id = ?;`,
      [cartId],
    );
    return Number(rows[0].n);
  }

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

  public async deleteIdempotencyKeysByScope(scope: string): Promise<void> {
    await this.query(`DELETE FROM idempotency_key WHERE scope = ?;`, [scope]);
  }
}
