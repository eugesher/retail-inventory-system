import { DataSource } from 'typeorm';

// E2E helper for the ledger-dedupe proof. Every assertion here reads the DATABASE,
// never the HTTP stock read: the whole defect is that two concurrent writers each
// believed the ledger was empty, so the ledger row COUNT is the thing under test and
// a cache-aside read would not show it. `stock_level` is read the same way for the
// same reason — the counters are the balance authority (ADR-030 §2, "audit not
// balance"), and a double-decrement is only visible in the row itself.
export class CommitSaleDedupeE2ESpecDataSource extends DataSource {
  // Commit Sale ships ALLOCATED units, and an allocation needs a real `reservation`
  // row — whose `cart_id` carries an FK onto `cart`. A guest cart (`customer_id` NULL)
  // is the cheapest fixture that satisfies it without booting retail: this spec is
  // about the inventory ledger, and driving a full checkout to reach it would put the
  // race behind three services that have nothing to do with the defect.
  public async createGuestCart(cartId: string): Promise<void> {
    await this.query(
      `INSERT INTO cart (id, customer_id, currency, status) VALUES (?, NULL, 'USD', 'active');`,
      [cartId],
    );
  }

  public async getStockLevelRow(
    variantId: number,
    stockLocationId: string,
  ): Promise<{ quantity_on_hand: number; quantity_allocated: number } | undefined> {
    const rows = await this.query(
      `
        SELECT quantity_on_hand, quantity_allocated
        FROM stock_level
        WHERE variant_id = ? AND stock_location_id = ?;
      `,
      [variantId, stockLocationId],
    );
    return rows[0];
  }

  // The ledger rows one business document produced, narrowed by type — the count is
  // the idempotency assertion.
  public async getMovementRows(
    referenceType: string,
    referenceId: string,
    type: string,
  ): Promise<{ variant_id: number; stock_location_id: string; quantity: number }[]> {
    return await this.query(
      `
        SELECT variant_id, stock_location_id, quantity
        FROM stock_movement
        WHERE reference_type = ? AND reference_id = ? AND type = ?
        ORDER BY id;
      `,
      [referenceType, referenceId, type],
    );
  }
}
