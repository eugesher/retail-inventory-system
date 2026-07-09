export enum MicroserviceQueueEnum {
  INVENTORY_QUEUE = 'inventory_queue',
  RETAIL_QUEUE = 'retail_queue',
  NOTIFICATION_EVENTS = 'notification_events',
  CATALOG_QUEUE = 'catalog_queue',
  // The event store's ingest queue. It binds the `ris.events` topic exchange with the
  // catch-all `#` (a lone `#`, NOT `#.#`, see `FirehoseConsumer`) so it receives the
  // whole event firehose, then dispatches by routing key.
  EVENT_STORE_FIREHOSE_QUEUE = 'event_store_firehose_queue',
  // The event store's RPC queue. Bound to the DEFAULT exchange — command traffic never
  // rides the `ris.events` topic exchange the firehose queue is bound to. A second,
  // disjoint transport on the same Nest application (ADR-039).
  EVENT_STORE_QUERY_QUEUE = 'event_store_query_queue',
}
