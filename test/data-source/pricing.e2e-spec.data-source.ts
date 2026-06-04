import { DataSource } from 'typeorm';

// E2E helper for the pricing flow. The price ledger keeps at most one **open**
// (`valid_to IS NULL`) row per `(variant_id, currency)` scope — enforced both by
// the repository's close-in-transaction and by the `open_scope_key` UNIQUE
// backstop. The concurrency test fires two `POST .../prices` at once and then
// asserts the invariant directly against the table (the read endpoints only
// surface rows *in effect at an instant*, not the full open/closed set), so this
// helper counts the open rows for a scope.
export class PricingE2ESpecDataSource extends DataSource {
  public async countOpenPrices(variantId: number, currency: string): Promise<number> {
    const rows = (await this.query(
      `
        SELECT COUNT(*) AS open_count
        FROM price
        WHERE variant_id = ?
          AND currency = ?
          AND valid_to IS NULL;
      `,
      [variantId, currency],
    )) as { open_count: number | string }[];

    // mysql2 returns COUNT(*) as a string — coerce to a number for the assertion.
    return Number(rows[0]?.open_count ?? 0);
  }
}
