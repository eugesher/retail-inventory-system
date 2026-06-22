import { InventoryAutoInitE2ESpecDataSource } from './inventory-auto-init.e2e-spec.data-source';

// One `notification_delivery` row, projected to the fields the notification e2e suites
// assert on. The gateway deliveries query exposes most of these too, but a direct row read
// is the most direct proof of the columns the audit trail is built on — especially
// `recipient_customer_id` being NULL for a system/ops delivery (a low-stock alert has no
// customer), which no public response massages.
//
// mysql2 returns BIGINT columns (the ids) as strings, so `id` / `templateId` are coerced
// with `Number(...)`; `attemptCount` is a plain INT but coerced for the same plain-number
// comparison ergonomics.
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

// E2E helper for the notification suites. Reads the `notification_delivery` audit trail by
// its business event reference (`event_reference_type` + `event_reference_id`) — the same
// key the gateway deliveries query filters on — so a suite can poll for the row(s) a placed
// order / shipped fulfillment / low-stock adjustment produced and assert on the persisted
// columns directly. Extends the inventory auto-init data source so a suite can also poll
// `stock_level` for the async catalog-variant-created auto-init before provisioning stock
// (the returns/refunds data-source precedent).
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
