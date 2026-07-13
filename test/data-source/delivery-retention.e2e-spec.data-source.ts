import { DataSource } from 'typeorm';

// E2E helper for the delivery-retention sweep (ISSUE-08). Rows are seeded straight into
// `notification_delivery` with a chosen `created_at`, because the sweep's only question is *how old
// is this row* and the domain has no way to backdate one — `NotificationDelivery.open()` stamps the
// present, and the mapper stamps the DB default.
//
// The assertions read the table directly. **They have to**: a purge's whole observable effect is the
// row's absence, and no read path in the application can distinguish "purged" from "never existed".
export class DeliveryRetentionE2ESpecDataSource extends DataSource {
  // A `sent` delivery for a template that exists, aged to `createdAt`. `recipient_customer_id` is
  // NULL on purpose: a customer-facing row would generate a `delivery_dedupe_key` and collide with
  // its siblings under the UNIQUE — and this spec is about age, not dedupe.
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

  // Any template row will do — the sweep never reads one, but `template_id` carries an FK.
  public async anyTemplateId(): Promise<number> {
    const rows = (await this.query(
      'SELECT id FROM notification_template ORDER BY id LIMIT 1;',
    )) as { id: number }[];
    return rows[0].id;
  }
}
