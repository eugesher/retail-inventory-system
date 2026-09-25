import { DataSource } from 'typeorm';

export class OrphanedQueuedE2ESpecDataSource extends DataSource {
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

  public async anyTemplateId(): Promise<number> {
    const rows = (await this.query(
      'SELECT id FROM notification_template ORDER BY id LIMIT 1;',
    )) as { id: number }[];
    return rows[0].id;
  }
}
