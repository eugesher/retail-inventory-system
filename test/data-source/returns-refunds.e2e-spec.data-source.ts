import { InventoryAutoInitE2ESpecDataSource } from './inventory-auto-init.e2e-spec.data-source';

export interface IPaymentRowProjection {
  id: number;
  status: string;
  amountMinor: number;
  refundedAmountMinor: number;
  flaggedForRefund: number;
}

export interface IRefundRowProjection {
  id: number;
  paymentId: number;
  amountMinor: number;
  status: string;
  reason: string;
}

export class ReturnsRefundsE2ESpecDataSource extends InventoryAutoInitE2ESpecDataSource {
  public async getPaymentByOrderId(orderId: number): Promise<IPaymentRowProjection | undefined> {
    const rows: Record<string, unknown>[] = await this.query(
      `
        SELECT id, status, amount_minor, refunded_amount_minor, flagged_for_refund
        FROM payment
        WHERE order_id = ?
        LIMIT 1;
      `,
      [orderId],
    );
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return {
      id: Number(row.id),
      status: String(row.status),
      amountMinor: Number(row.amount_minor),
      refundedAmountMinor: Number(row.refunded_amount_minor),
      flaggedForRefund: Number(row.flagged_for_refund),
    };
  }

  public async getRefundsByOrderId(orderId: number): Promise<IRefundRowProjection[]> {
    const rows: Record<string, unknown>[] = await this.query(
      `
        SELECT id, payment_id, amount_minor, status, reason
        FROM refund
        WHERE order_id = ?
        ORDER BY id DESC;
      `,
      [orderId],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      paymentId: Number(row.payment_id),
      amountMinor: Number(row.amount_minor),
      status: String(row.status),
      reason: String(row.reason),
    }));
  }
}
