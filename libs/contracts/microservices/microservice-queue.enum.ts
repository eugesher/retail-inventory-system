export enum MicroserviceQueueEnum {
  INVENTORY_QUEUE = 'inventory_queue',
  RETAIL_QUEUE = 'retail_queue',
  NOTIFICATION_EVENTS = 'notification_events',
  CATALOG_QUEUE = 'catalog_queue',
  // The event store's single consumer queue. It binds the default exchange today (an
  // idle listener with no handlers); a later capability re-points it at the
  // `ris.events` topic exchange with `#.#` wildcards so it receives the whole event
  // firehose.
  EVENT_STORE_FIREHOSE_QUEUE = 'event_store_firehose_queue',
}
