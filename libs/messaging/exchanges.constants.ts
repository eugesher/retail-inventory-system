export const EXCHANGES = {
  RETAIL: 'retail',
  INVENTORY: 'inventory',
  NOTIFICATION: 'notification',
  RIS_EVENTS_TOPIC: 'ris.events',
} as const;

export type Exchange = (typeof EXCHANGES)[keyof typeof EXCHANGES];
