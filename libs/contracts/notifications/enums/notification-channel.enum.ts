// The business channel a notification is delivered over (how the customer is
// reached) — distinct from the NOTIFIER *transport* adapter (log/email/webhook).
// A wire contract: it is a DB ENUM column on notification_template /
// notification_delivery and crosses the gateway↔notification RPC boundary.
export enum NotificationChannelEnum {
  EMAIL = 'email',
  SMS = 'sms',
  PUSH = 'push',
  WEBHOOK = 'webhook',
}
