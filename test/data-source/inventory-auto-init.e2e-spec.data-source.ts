import { DataSource } from 'typeorm';

// E2E helper for the auto-init flow. The catalog-variant-created consumer creates
// the `stock_level` row asynchronously, so the spec polls the database directly
// to know the consumer has run before asserting through the (cache-aside) HTTP
// GET — reading the row over HTTP first would cache a `locations: []` answer that
// the read path does not invalidate. The row count is also the authoritative
// idempotency check: a repeat event must not append a second row.
export class InventoryAutoInitE2ESpecDataSource extends DataSource {
  public async getStockLevelRows(variantId: number): Promise<any> {
    return await this.query(
      `
        SELECT stock_location_id, quantity_on_hand, quantity_allocated, quantity_reserved, version
        FROM stock_level
        WHERE variant_id = ?
        ORDER BY stock_location_id;
      `,
      [variantId],
    );
  }
}
