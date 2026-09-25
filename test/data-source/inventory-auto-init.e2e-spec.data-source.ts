import { DataSource } from 'typeorm';

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
