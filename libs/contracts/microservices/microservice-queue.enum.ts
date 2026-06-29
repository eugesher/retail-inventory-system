export enum MicroserviceQueueEnum {
  INVENTORY_QUEUE = 'inventory_queue',
  RETAIL_QUEUE = 'retail_queue',
  NOTIFICATION_EVENTS = 'notification_events',
  CATALOG_QUEUE = 'catalog_queue',
  // The event store's single consumer queue. It binds the `ris.events` topic exchange
  // with the catch-all `#` (a lone `#`, NOT `#.#`, see `FirehoseConsumer`) so it receives
  // the whole event firehose, then dispatches by routing key.
  EVENT_STORE_FIREHOSE_QUEUE = 'event_store_firehose_queue',
}
