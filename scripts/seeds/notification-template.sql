-- One active `email` / `en-US` / `version=1` notification template per event type the
-- notification consumers route through `RenderAndDispatchUseCase`. Without a matching
-- `notification_template` row the render pipeline warn-logs "no active template" and
-- persists no delivery, so this seed is what makes a real `notification_delivery` row
-- appear end to end (the consumer resolves the latest active template by
-- `(event_type, channel, locale)`, renders subject/body against the event, then sends).
--
-- `event_type` is the dotted routing-key string the consumer passes as the template key's
-- first component (e.g. `retail.order.placed`) — it MUST match `ROUTING_KEYS.*` exactly.
-- `subject`/`body` are Handlebars source rendered against the wire event as the context
-- (the consumer hands the whole event object to the renderer). Every `{{placeholder}}` is
-- matched to an actual field on that event's contract in
-- `libs/contracts/{retail,inventory}/events/*`; a placeholder with no matching field
-- renders empty (Handlebars default), so the names are kept aligned with the contracts.
-- Note the shipment + cancellation events carry `orderId` (no `orderNumber`), so those
-- subjects/bodies key on `orderId`.
--
-- `channel='email'` is the only business channel this capability dispatches over today;
-- `email` requires a non-null subject (the channel-specific subject invariant). `version=1`
-- and `active=1`: these are the baseline live templates. An over-the-API author appends a
-- HIGHER version (newest-active-wins resolution), so a later edit/rollback never has to
-- touch these rows.
--
-- INSERT IGNORE + the UNIQUE `(event_type, channel, locale, version)` make a re-run a
-- no-op: the natural-key collision is ignored, so re-seeding never errors or duplicates a
-- template row. `id` is left to auto-increment; `created_at`/`updated_at` default at the
-- column; `deleted_at` stays NULL (soft-delete is the `active` flag, not the timestamp).
-- No FK dependency — this seed can run in any position in the seed order.
INSERT IGNORE INTO notification_template (event_type, channel, locale, subject, body, version, active)
VALUES
  ('retail.order.placed', 'email', 'en-US',
   'Order #{{orderNumber}} confirmed',
   'Thank you! Order #{{orderNumber}} is confirmed: {{lineCount}} item(s) totaling {{grandTotalMinor}} {{currency}}.',
   1, 1),
  ('retail.fulfillment.shipped', 'email', 'en-US',
   'Order #{{orderId}} has shipped',
   'Your order #{{orderId}} has shipped via {{carrier}}. Track it with {{trackingNumber}}.',
   1, 1),
  ('retail.fulfillment.delivered', 'email', 'en-US',
   'Your order arrived',
   'Good news — your order #{{orderId}} has been delivered.',
   1, 1),
  ('retail.order.cancelled', 'email', 'en-US',
   'Order #{{orderId}} cancelled',
   'Your order #{{orderId}} has been cancelled. Reason: {{reason}}.',
   1, 1),
  ('retail.return.requested', 'email', 'en-US',
   'Return {{rmaNumber}} received',
   'We have received your return request {{rmaNumber}} for {{lineCount}} item(s).',
   1, 1),
  ('retail.return.authorized', 'email', 'en-US',
   'Return {{rmaNumber}} authorized',
   'Your return {{rmaNumber}} has been authorized. Please ship the item(s) back to us.',
   1, 1),
  ('retail.return.received', 'email', 'en-US',
   'Return {{rmaNumber}} received at warehouse',
   'We have received the item(s) for return {{rmaNumber}} at our warehouse.',
   1, 1),
  ('retail.return.inspected', 'email', 'en-US',
   'Return {{rmaNumber}} inspected',
   'Return {{rmaNumber}} has been inspected. {{restockedLineCount}} item(s) returned to stock.',
   1, 1),
  ('retail.refund.issued', 'email', 'en-US',
   'Refund issued',
   'A refund of {{amountMinor}} {{currency}} for order #{{orderId}} has been issued.',
   1, 1),
  ('inventory.stock.low', 'email', 'en-US',
   'Low stock alert',
   'Low stock for variant {{variantId}} at {{stockLocationId}}: {{quantity}} on hand (threshold {{threshold}}).',
   1, 1);
