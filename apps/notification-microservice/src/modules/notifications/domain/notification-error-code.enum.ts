// Stable, greppable codes for every notification-context invariant violation —
// covering the `NotificationTemplate` versioned registry and the
// `NotificationDelivery` audit trail. A presentation-layer exception filter maps the
// `code` onto an HTTP status + wire error shape (`{ statusCode, message, code }`),
// keeping the domain transport-free (the `CatalogErrorCodeEnum` / `OrderErrorCodeEnum`
// / `ReturnErrorCodeEnum` convention). The HTTP filter that maps these arrives with the
// template/delivery operations, not this foundation — so **every** code is declared now
// (the filter's `Record` is total) even though the foundation throws only the shape
// codes; each is annotated with its thrower.
export enum NotificationErrorCodeEnum {
  // --- Thrown by the domain model (this foundation) ---
  // A template's `body` (the Handlebars source) must be non-empty — thrown by
  // `NotificationTemplate.create`, 400.
  TEMPLATE_BODY_REQUIRED = 'NOTIFICATION_TEMPLATE_BODY_REQUIRED',
  // A template's `subject` is required for the `email`/`webhook` channels (an email
  // without a subject line, a webhook without a title, is malformed); it stays optional
  // for `sms`/`push` — thrown by `NotificationTemplate.create`, 400.
  TEMPLATE_SUBJECT_REQUIRED = 'NOTIFICATION_TEMPLATE_SUBJECT_REQUIRED',
  // A template's `eventType` (the trigger key, e.g. `retail.order.placed`) must be
  // non-empty — thrown by `NotificationTemplate.create`, 400.
  TEMPLATE_EVENT_TYPE_REQUIRED = 'NOTIFICATION_TEMPLATE_EVENT_TYPE_REQUIRED',
  // A template's `locale` (the BCP-47 tag, e.g. `en-US`) must be non-empty — thrown by
  // `NotificationTemplate.create`, 400.
  TEMPLATE_LOCALE_REQUIRED = 'NOTIFICATION_TEMPLATE_LOCALE_REQUIRED',
  // A template's `version` must be a positive integer — thrown by
  // `NotificationTemplate.create`, 400.
  TEMPLATE_VERSION_INVALID = 'NOTIFICATION_TEMPLATE_VERSION_INVALID',
  // A delivery's `recipientAddress` must be non-empty (the concrete email/phone/url the
  // message goes to) — thrown by `NotificationDelivery.open`, 400.
  DELIVERY_RECIPIENT_REQUIRED = 'NOTIFICATION_DELIVERY_RECIPIENT_REQUIRED',
  // A delivery status mutator was called from a state that does not allow it
  // (`markSent`/`markFailed` off a terminal state, `markDelivered`/`markBounced` off a
  // non-`sent` state) — a well-formed request the resource state forbids, thrown by the
  // `NotificationDelivery` mutators, 409.
  DELIVERY_INVALID_STATUS_TRANSITION = 'NOTIFICATION_DELIVERY_INVALID_STATUS_TRANSITION',

  // --- Thrown by the use cases (later capabilities) ---
  // The template being read/edited does not exist — 404 (the Author/Activate/List
  // operations resolve a template by id or natural key).
  TEMPLATE_NOT_FOUND = 'NOTIFICATION_TEMPLATE_NOT_FOUND',
  // An edit tried to author a `(eventType, channel, locale, version)` row that already
  // exists — the version-bump derivation collided — 409 (the Author use case).
  TEMPLATE_DUPLICATE_VERSION = 'NOTIFICATION_TEMPLATE_DUPLICATE_VERSION',
  // The delivery being read/operated on does not exist — 404 (the Record Outcome /
  // Retry operations resolve a delivery by id).
  DELIVERY_NOT_FOUND = 'NOTIFICATION_DELIVERY_NOT_FOUND',
}
