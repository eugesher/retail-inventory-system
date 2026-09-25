import { DataSource } from 'typeorm';

export class DeliveryRetentionE2ESpecDataSource extends DataSource {
  public async seedDelivery(
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
       VALUES (?, NULL, 'ops@example.com', 'email', 'order', ?, 'sent', 1, ?,
               'Retention fixture', 'body', ?, ?, ?);`,
      [
        templateId,
        eventReferenceId,
        createdAt,
        `corr-retention-${eventReferenceId}`,
        createdAt,
        createdAt,
      ],
    )) as { insertId: number };
    return result.insertId;
  }

  public async deliveryExists(id: number): Promise<boolean> {
    const rows = (await this.query('SELECT 1 AS present FROM notification_delivery WHERE id = ?;', [
      id,
    ])) as unknown[];
    return rows.length > 0;
  }

  public async anyTemplateId(): Promise<number> {
    const rows = (await this.query(
      'SELECT id FROM notification_template ORDER BY id LIMIT 1;',
    )) as { id: number }[];
    return rows[0].id;
  }
}
