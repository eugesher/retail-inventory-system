// Exchange identifiers. `RETAIL` / `INVENTORY` / `NOTIFICATION` remain reserved
// placeholders — every operational queue still binds the default exchange and
// no producer addresses them (ADR-008/020).
//
// `RIS_EVENTS_TOPIC` is the one live exchange (ADR-035): a durable `topic`
// exchange onto which producers **mirror** their events (dual-publish) so the
// event store can capture the whole firehose from a single `#.#`-bound queue
// without re-binding any existing consumer. This is the follow-up wiring the
// reservation note in ADR-008 required before any topic exchange is introduced.
export const EXCHANGES = {
  RETAIL: 'retail',
  INVENTORY: 'inventory',
  NOTIFICATION: 'notification',
  RIS_EVENTS_TOPIC: 'ris.events',
} as const;

export type Exchange = (typeof EXCHANGES)[keyof typeof EXCHANGES];
