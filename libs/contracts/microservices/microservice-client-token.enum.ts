export enum MicroserviceClientTokenEnum {
  INVENTORY_MICROSERVICE = 'INVENTORY_MICROSERVICE',
  RETAIL_MICROSERVICE = 'RETAIL_MICROSERVICE',
  NOTIFICATION_MICROSERVICE = 'NOTIFICATION_MICROSERVICE',
  CATALOG_MICROSERVICE = 'CATALOG_MICROSERVICE',

  // Request channel for the event store's `audit.*` query RPCs, targeting
  // `event_store_query_queue` over the default exchange. Contrast
  // RIS_EVENTS_PUBLISHER, which is a fan-out destination on the `ris.events`
  // topic exchange, not a request channel.
  EVENT_STORE_MICROSERVICE = 'EVENT_STORE_MICROSERVICE',

  // The producer-side client for the `ris.events` topic exchange (ADR-035).
  // Unlike the four above — each a default-exchange client targeting one
  // consumer queue — this one targets the `ris.events` topic exchange itself:
  // `emit(routingKey, payload)` publishes with `routingKey` as the AMQP topic
  // routing key, so the event store's `#`-bound firehose queue receives every
  // mirrored event. Held by `RisEventsMirrorPublisher` and the real audit-log
  // adapters; it is a fan-out destination, not a per-service request channel.
  RIS_EVENTS_PUBLISHER = 'RIS_EVENTS_PUBLISHER',
}
