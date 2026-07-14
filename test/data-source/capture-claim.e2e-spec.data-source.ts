import { DataSource } from 'typeorm';

// E2E helper for the capture-claim proof (ADR-052). It reads the `payment` row directly, because the
// question — *"was this authorization charged once, twice, or not at all?"* — is answered by the row
// and by the gateway call count, never by the HTTP response: the losing racer's response looks
// identical whether its charge landed or not.
export class CaptureClaimE2ESpecDataSource extends DataSource {
  public async getPayment(
    orderId: number,
  ): Promise<{ status: string; captured_at: Date | null } | undefined> {
    const rows = await this.query(
      `SELECT status, captured_at FROM payment WHERE order_id = ? ORDER BY id DESC LIMIT 1;`,
      [orderId],
    );
    return rows[0];
  }

  public async getStockLevelCount(variantId: number): Promise<number> {
    const rows = await this.query(`SELECT COUNT(*) AS n FROM stock_level WHERE variant_id = ?;`, [
      variantId,
    ]);
    return Number(rows[0].n);
  }
}
