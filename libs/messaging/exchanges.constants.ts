// Exchange identifiers reserved for future routing changes. RabbitMQ today
// uses one queue per service without explicit exchanges; the constants
// land here so future migration to topic-exchange routing has a home.
export const EXCHANGES = {
  RETAIL: 'retail',
  INVENTORY: 'inventory',
  NOTIFICATION: 'notification',
} as const;

export type Exchange = (typeof EXCHANGES)[keyof typeof EXCHANGES];
