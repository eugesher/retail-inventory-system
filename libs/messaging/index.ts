export * from './exchanges.constants';
export * from './messaging.module';
export * from './microservice-client-catalog.module';
export * from './microservice-client-inventory.module';
export * from './microservice-client-notification.module';
export * from './microservice-client-retail.module';
export * from './microservice-client-ris-events.module';
export * from './microservice-client.configuration';
export * from './rabbitmq.client.factory';
export * from './ris-events-mirror.publisher';
export * from './routing-keys.constants';
export * from './rpc-passthrough';

// Re-exports of transport identifiers from `libs/contracts`. `libs/messaging`
// is the consumer; `libs/contracts` remains the source of truth for queue
// names and DI tokens.
export {
  MicroserviceClientTokenEnum,
  MicroserviceQueueEnum,
} from '@retail-inventory-system/contracts';
