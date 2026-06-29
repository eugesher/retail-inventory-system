import { ClientProxy } from '@nestjs/microservices';
import { PinoLogger } from 'nestjs-pino';
import { of } from 'rxjs';

import {
  ICorrelationPayload,
  IRetailReturnAuthorizedEvent,
  IRetailReturnClosedEvent,
  IRetailReturnInspectedEvent,
  IRetailReturnReceivedEvent,
  IRetailReturnRejectedEvent,
  IRetailReturnRequestedEvent,
} from '@retail-inventory-system/contracts';
import { RisEventsMirrorPublisher, ROUTING_KEYS } from '@retail-inventory-system/messaging';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { ReturnRabbitmqPublisher } from '../return-rabbitmq.publisher';

// Proves the returns publisher dual-publishes (ADR-035): the whole RMA lifecycle
// keeps its primary emit (buyer-facing four onto `notification_events`, internal
// two onto `retail_queue`) AND mirrors the same routing key + wire onto
// `ris.events`.
describe('ReturnRabbitmqPublisher dual-publish', () => {
  let notificationEmit: jest.Mock;
  let retailEmit: jest.Mock;
  let mirror: RisEventsMirrorPublisher;
  let mirrorSpy: jest.SpyInstance;
  let publisher: ReturnRabbitmqPublisher;

  beforeEach(() => {
    notificationEmit = jest.fn().mockReturnValue(of(undefined));
    retailEmit = jest.fn().mockReturnValue(of(undefined));
    mirror = new RisEventsMirrorPublisher(
      { emit: jest.fn().mockReturnValue(of(undefined)) } as unknown as ClientProxy,
      makePinoLoggerMock() as unknown as PinoLogger,
    );
    mirrorSpy = jest.spyOn(mirror, 'mirror');
    publisher = new ReturnRabbitmqPublisher(
      { emit: notificationEmit } as unknown as ClientProxy,
      { emit: retailEmit } as unknown as ClientProxy,
      mirror,
    );
  });

  const event = <T>(): T => ({ correlationId: 'cid' }) as unknown as T;

  const requested = event<IRetailReturnRequestedEvent>();
  const authorized = event<IRetailReturnAuthorizedEvent>();
  const received = event<IRetailReturnReceivedEvent>();
  const inspected = event<IRetailReturnInspectedEvent>();
  const rejected = event<IRetailReturnRejectedEvent>();
  const closed = event<IRetailReturnClosedEvent>();

  interface ICase {
    name: string;
    routingKey: string;
    primary: () => jest.Mock;
    payload: ICorrelationPayload;
    invoke: () => Promise<void>;
  }

  const cases: ICase[] = [
    {
      name: 'return.requested',
      routingKey: ROUTING_KEYS.RETAIL_RETURN_REQUESTED,
      primary: () => notificationEmit,
      payload: requested,
      invoke: () => publisher.publishReturnRequested(requested),
    },
    {
      name: 'return.authorized',
      routingKey: ROUTING_KEYS.RETAIL_RETURN_AUTHORIZED,
      primary: () => notificationEmit,
      payload: authorized,
      invoke: () => publisher.publishReturnAuthorized(authorized),
    },
    {
      name: 'return.received',
      routingKey: ROUTING_KEYS.RETAIL_RETURN_RECEIVED,
      primary: () => notificationEmit,
      payload: received,
      invoke: () => publisher.publishReturnReceived(received),
    },
    {
      name: 'return.inspected',
      routingKey: ROUTING_KEYS.RETAIL_RETURN_INSPECTED,
      primary: () => notificationEmit,
      payload: inspected,
      invoke: () => publisher.publishReturnInspected(inspected),
    },
    {
      name: 'return.rejected',
      routingKey: ROUTING_KEYS.RETAIL_RETURN_REJECTED,
      primary: () => retailEmit,
      payload: rejected,
      invoke: () => publisher.publishReturnRejected(rejected),
    },
    {
      name: 'return.closed',
      routingKey: ROUTING_KEYS.RETAIL_RETURN_CLOSED,
      primary: () => retailEmit,
      payload: closed,
      invoke: () => publisher.publishReturnClosed(closed),
    },
  ];

  it.each(cases)(
    'mirrors $name onto ris.events alongside the primary emit',
    async ({ routingKey, primary, payload, invoke }) => {
      await invoke();

      expect(primary()).toHaveBeenCalledWith(routingKey, payload);
      expect(mirrorSpy).toHaveBeenCalledTimes(1);
      expect(mirrorSpy).toHaveBeenCalledWith(routingKey, payload);
    },
  );
});
