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

  // Forges a capture claim that has been open for `minutesAgo` minutes — a payment whose charge died
  // mid-flight (ADR-052). There is no API that produces one: the happy paths resolve a claim in a
  // gateway round-trip, and the only thing that strands one is a process that dies between the commit
  // and the charge. So the row is written directly.
  //
  // **`NOW() - INTERVAL … MINUTE` is computed by MySQL, deliberately — no JS `Date` crosses the wire.**
  // This DataSource does not pin `timezone: 'Z'` the way `DatabaseModule.forRoot` does, so `mysql2`
  // would marshal a JS `Date` through the **Node host's** local zone (UTC+7 on this machine) while the
  // application's own connection speaks UTC. A seven-hour skew against a fifteen-minute horizon does
  // not fail loudly — it silently decides the answer. Keeping the arithmetic server-side removes the
  // question.
  //
  // The explicit `updated_at` assignment also **overrides** the column's `ON UPDATE CURRENT_TIMESTAMP`
  // (MySQL only auto-stamps a column the statement does not set), which is the only reason a row can
  // be aged at all.
  public async strandCaptureClaim(orderId: number, minutesAgo: number): Promise<void> {
    await this.agePayment(orderId, 'capturing', minutesAgo);
  }

  // The same forgery, at an arbitrary status — the negative control for the report's STATUS predicate.
  //
  // **Ageing the row is the whole point of this method existing separately.** A plain
  // `UPDATE payment SET status = 'authorized'` re-stamps `updated_at` to `NOW()` through the column's
  // `ON UPDATE CURRENT_TIMESTAMP`, so the row would then fall outside the report's horizon as well as
  // its status filter — and a query that had **lost its status predicate entirely** would still exclude
  // it, and the test would pass while proving nothing. (It did. A mutation run caught it: deleting
  // `WHERE status = 'capturing'` from the repository left all four tests green.) Holding `updated_at`
  // old isolates the status as the only reason the row can drop out.
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
