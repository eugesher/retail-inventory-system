import { DataSource } from 'typeorm';

export class CommitSaleDedupeE2ESpecDataSource extends DataSource {
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
