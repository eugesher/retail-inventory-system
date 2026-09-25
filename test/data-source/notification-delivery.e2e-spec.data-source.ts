import { InventoryAutoInitE2ESpecDataSource } from './inventory-auto-init.e2e-spec.data-source';

export interface INotificationDeliveryRowProjection {
  id: number;
  templateId: number;
  recipientCustomerId: string | null;
  recipientAddress: string;
  channel: string;
  eventReferenceType: string;
  eventReferenceId: string;
  status: string;
  attemptCount: number;
  renderedSubject: string | null;
  renderedBody: string;
}

export class NotificationDeliveryE2ESpecDataSource extends InventoryAutoInitE2ESpecDataSource {
  public async getDeliveriesByEventRef(
    eventReferenceType: string,
    eventReferenceId: string,
  ): Promise<INotificationDeliveryRowProjection[]> {
    const rows: Record<string, unknown>[] = await this.query(
      `
        SELECT id, template_id, recipient_customer_id, recipient_address, channel,
               event_reference_type, event_reference_id, status, attempt_count,
               rendered_subject, rendered_body
        FROM notification_delivery
        WHERE event_reference_type = ? AND event_reference_id = ?
        ORDER BY id DESC;
      `,
      [eventReferenceType, eventReferenceId],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      templateId: Number(row.template_id),
      recipientCustomerId: (row.recipient_customer_id as string | null) ?? null,
      recipientAddress: String(row.recipient_address),
      channel: String(row.channel),
      eventReferenceType: String(row.event_reference_type),
      eventReferenceId: String(row.event_reference_id),
      status: String(row.status),
      attemptCount: Number(row.attempt_count),
      renderedSubject: (row.rendered_subject as string | null) ?? null,
      renderedBody: String(row.rendered_body),
    }));
  }
}
