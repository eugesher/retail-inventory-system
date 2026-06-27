import { ClientProxy } from '@nestjs/microservices';
import { PinoLogger } from 'nestjs-pino';
import { of } from 'rxjs';

import {
  ICatalogPriceChangedEvent,
  ICatalogPriceScheduledEvent,
  ICorrelationPayload,
} from '@retail-inventory-system/contracts';
import { RisEventsMirrorPublisher, ROUTING_KEYS } from '@retail-inventory-system/messaging';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { PricingRabbitmqPublisher } from '../pricing-rabbitmq.publisher';

// Proves the pricing publisher dual-publishes (ADR-035): both reserved
// `catalog.price.*` events keep their primary `catalog_queue` emit AND mirror the
// same routing key + wire onto `ris.events`.
describe('PricingRabbitmqPublisher dual-publish', () => {
  let catalogEmit: jest.Mock;
  let mirror: RisEventsMirrorPublisher;
  let mirrorSpy: jest.SpyInstance;
  let publisher: PricingRabbitmqPublisher;

  beforeEach(() => {
    catalogEmit = jest.fn().mockReturnValue(of(undefined));
    mirror = new RisEventsMirrorPublisher(
      { emit: jest.fn().mockReturnValue(of(undefined)) } as unknown as ClientProxy,
      makePinoLoggerMock() as unknown as PinoLogger,
    );
    mirrorSpy = jest.spyOn(mirror, 'mirror');
    publisher = new PricingRabbitmqPublisher(
      { emit: catalogEmit } as unknown as ClientProxy,
      mirror,
    );
  });

  const changed = { correlationId: 'cid' } as unknown as ICatalogPriceChangedEvent;
  const scheduled = { correlationId: 'cid' } as unknown as ICatalogPriceScheduledEvent;

  interface ICase {
    name: string;
    routingKey: string;
    event: ICorrelationPayload;
    invoke: () => Promise<void>;
  }

  const cases: ICase[] = [
    {
      name: 'price.changed',
      routingKey: ROUTING_KEYS.CATALOG_PRICE_CHANGED,
      event: changed,
      invoke: () => publisher.publishPriceChanged(changed),
    },
    {
      name: 'price.scheduled',
      routingKey: ROUTING_KEYS.CATALOG_PRICE_SCHEDULED,
      event: scheduled,
      invoke: () => publisher.publishPriceScheduled(scheduled),
    },
  ];

  it.each(cases)(
    'mirrors $name onto ris.events alongside the primary emit',
    async ({ routingKey, event, invoke }) => {
      await invoke();

      expect(catalogEmit).toHaveBeenCalledWith(routingKey, event);
      expect(mirrorSpy).toHaveBeenCalledTimes(1);
      expect(mirrorSpy).toHaveBeenCalledWith(routingKey, event);
    },
  );
});
