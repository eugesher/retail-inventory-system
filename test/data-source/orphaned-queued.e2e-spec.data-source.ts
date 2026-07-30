import { DataSource } from 'typeorm';

// E2E helper for the orphaned-`queued` rescue. A row is seeded straight into
// `notification_delivery` at `status = 'queued'` with a chosen `created_at`, because that is the
// one state the application cannot be asked to produce: the pipeline writes `queued` and flips it
// within the same call, so the only way to observe a row STUCK there is to write one — which is
// precisely what a crashed process, or a failed second `save`, leaves behind.
//
// `recipient_customer_id` is NULL, as in the retention fixture: a customer-facing row would
// generate a `delivery_dedupe_key` and collide with its siblings under the UNIQUE, and this spec is
// about the sweeper's scan, not about dedupe.
export class OrphanedQueuedE2ESpecDataSource extends DataSource {
  // A delivery orphaned in `queued`, aged to `createdAt`. `attempt_count = 0` and
  // `last_attempt_at = NULL` because nothing was ever *recorded* against it — that combination is
  // the signature of the failure this rescues, and it is also why neither the old scan
  // (`status = 'failed'`) nor the old manual-retry guard could see it.
  public async seedOrphanedQueued(
    templateId: number,
    eventReferenceId: string,
    createdAt: Date,
  ): Promise<number> {
    const result = (await this.query(
      `INSERT INTO notification_delivery
         (template_id, recipient_customer_id, recipient_address, channel,
          event_reference_type, event_reference_id, status, attempt_count,
          last_attempt_at, rendered_subject, rendered_body, correlation_id,
          created_at, updated_at)
       VALUES (?, NULL, 'ops@example.com', 'email', 'order', ?, 'queued', 0,
               NULL, 'Orphan fixture', 'body that was never sent', ?, ?, ?);`,
      [templateId, eventReferenceId, `corr-orphan-${eventReferenceId}`, createdAt, createdAt],
    )) as { insertId: number };
    return result.insertId;
  }

  public async statusOf(id: number): Promise<{ status: string; attemptCount: number } | null> {
    const rows = (await this.query(
      'SELECT status, attempt_count AS attemptCount FROM notification_delivery WHERE id = ?;',
      [id],
    )) as { status: string; attemptCount: number }[];
    return rows[0] ?? null;
  }

  public async deleteDelivery(id: number): Promise<void> {
    await this.query('DELETE FROM notification_delivery WHERE id = ?;', [id]);
  }

  // Any template row will do — the retry re-sends the row's own stored body and never resolves a
  // template, but `template_id` carries an FK.
  public async anyTemplateId(): Promise<number> {
    const rows = (await this.query(
      'SELECT id FROM notification_template ORDER BY id LIMIT 1;',
    )) as { id: number }[];
    return rows[0].id;
  }
}
