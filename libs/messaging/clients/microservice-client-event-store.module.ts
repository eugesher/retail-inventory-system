import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClientsModule } from '@nestjs/microservices';

import {
  MicroserviceClientTokenEnum,
  MicroserviceQueueEnum,
} from '@retail-inventory-system/contracts';

import { MicroserviceClientConfiguration } from '../clients/microservice-client.configuration';

// The request-side client for the event store's `audit.*` query RPCs (ADR-039).
//
// It is a plain default-exchange client, exactly like the four per-service modules
// beside it: `send(routingKey, payload)` publishes to the default exchange using
// `EVENT_STORE_QUERY_QUEUE` as the routing key, so the message lands on the queue the
// event store's second transport consumes (the producer targets the CONSUMER's queue,
// ADR-008/020).
//
// It has nothing to do with `MicroserviceClientRisEventsModule`, which targets the
// `ris.events` topic exchange the event store's OTHER queue is bound to. That one is a
// fire-and-forget event fan-out; this one is a request/reply channel. The event store is
// the only service reachable through both.
@Module({
  imports: [
    ConfigModule,
    ClientsModule.registerAsync([
      new MicroserviceClientConfiguration(
        MicroserviceClientTokenEnum.EVENT_STORE_MICROSERVICE,
        MicroserviceQueueEnum.EVENT_STORE_QUERY_QUEUE,
      ),
    ]),
  ],
  exports: [ClientsModule],
})
export class MicroserviceClientEventStoreModule {}
