export const TRANSACTIONAL_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  'retail.order.placed',
  'retail.order.cancelled',
  'retail.fulfillment.shipped',
  'retail.fulfillment.delivered',
  'retail.refund.issued',
  'retail.return.requested',
  'retail.return.authorized',
  'retail.return.received',
  'retail.return.inspected',
]);
