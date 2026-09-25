import { DataSource } from 'typeorm';

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

  public async strandCaptureClaim(orderId: number, minutesAgo: number): Promise<void> {
    await this.agePayment(orderId, 'capturing', minutesAgo);
  }

  public async agePayment(orderId: number, status: string, minutesAgo: number): Promise<void> {
    await this.query(
      `UPDATE payment
          SET status = ?,
              updated_at = NOW() - INTERVAL ? MINUTE
        WHERE order_id = ?;`,
      [status, minutesAgo, orderId],
    );
  }
}
