import { InventoryAutoInitE2ESpecDataSource } from './inventory-auto-init.e2e-spec.data-source';

// One captured `payment` row, projected to the fields the returns/refunds suites
// assert on. `PaymentView` (the HTTP response shape) deliberately omits the internal
// accounting columns `refunded_amount_minor` and `flagged_for_refund`, so the suites
// read them straight from the row — the cumulative refund total and the
// cancel-flag are the only authoritative proof that a refund (manual or auto) landed.
export interface IPaymentRowProjection {
  id: number;
  status: string;
  amountMinor: number;
  refundedAmountMinor: number;
  flaggedForRefund: number;
}

// One `refund` row, projected to the fields the suites assert on.
export interface IRefundRowProjection {
  id: number;
  paymentId: number;
  amountMinor: number;
  status: string;
  reason: string;
}

// E2E helper for the returns/refunds suites. Inherits `getStockLevelRows` (used to poll
// for the async catalog-variant-created auto-init before the cache-aside HTTP stock read,
// exactly as the fulfillment suites do) and adds two readers over the retail `payment` /
// `refund` tables.
//
// mysql2 returns BIGINT columns (the ids + the two minor-unit totals) as strings, so every
// numeric field is coerced with `Number(...)` here — keeping the suite assertions plain
// `=== <number>` comparisons rather than string/number guesswork.
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
