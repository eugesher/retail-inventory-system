import { ClientProxy } from '@nestjs/microservices';
import { PinoLogger } from 'nestjs-pino';
import { of, throwError } from 'rxjs';

import {
  ICorrelationPayload,
  IRetailCartCreatedEvent,
  IRetailCartLineAddedEvent,
  IRetailCartLineQuantityChangedEvent,
  IRetailCartLineRemovedEvent,
} from '@retail-inventory-system/contracts';
import { RisEventsMirrorPublisher, ROUTING_KEYS } from '@retail-inventory-system/messaging';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { CartRabbitmqPublisher } from '../cart-rabbitmq.publisher';

// Proves the cart publisher dual-publishes (ADR-035): the four reserved
// `retail.cart.*` events keep their primary `retail_queue` emit AND mirror the same
// routing key + wire onto `ris.events` — the first half of a Place Order firehose
// chain.
describe('CartRabbitmqPublisher dual-publish', () => {
  let retailEmit: jest.Mock;
  let mirrorEmit: jest.Mock;
  let mirror: RisEventsMirrorPublisher;
  let mirrorSpy: jest.SpyInstance;
  let publisher: CartRabbitmqPublisher;

  beforeEach(() => {
    retailEmit = jest.fn().mockReturnValue(of(undefined));
    mirrorEmit = jest.fn().mockReturnValue(of(undefined));
    mirror = new RisEventsMirrorPublisher(
      { emit: mirrorEmit } as unknown as ClientProxy,
      makePinoLoggerMock() as unknown as PinoLogger,
    );
    mirrorSpy = jest.spyOn(mirror, 'mirror');
    publisher = new CartRabbitmqPublisher({ emit: retailEmit } as unknown as ClientProxy, mirror);
  });

  const created = { correlationId: 'cid' } as unknown as IRetailCartCreatedEvent;
  const lineAdded = { correlationId: 'cid' } as unknown as IRetailCartLineAddedEvent;
  const lineRemoved = { correlationId: 'cid' } as unknown as IRetailCartLineRemovedEvent;
  const qtyChanged = { correlationId: 'cid' } as unknown as IRetailCartLineQuantityChangedEvent;

  interface ICase {
    name: string;
    routingKey: string;
    event: ICorrelationPayload;
    invoke: () => Promise<void>;
  }

  const cases: ICase[] = [
    {
      name: 'cart.created',
      routingKey: ROUTING_KEYS.RETAIL_CART_CREATED,
      event: created,
      invoke: () => publisher.publishCartCreated(created),
    },
    {
      name: 'cart.line-added',
      routingKey: ROUTING_KEYS.RETAIL_CART_LINE_ADDED,
      event: lineAdded,
      invoke: () => publisher.publishCartLineAdded(lineAdded),
    },
    {
      name: 'cart.line-removed',
      routingKey: ROUTING_KEYS.RETAIL_CART_LINE_REMOVED,
      event: lineRemoved,
      invoke: () => publisher.publishCartLineRemoved(lineRemoved),
    },
    {
      name: 'cart.line-quantity-changed',
      routingKey: ROUTING_KEYS.RETAIL_CART_LINE_QUANTITY_CHANGED,
      event: qtyChanged,
      invoke: () => publisher.publishCartLineQuantityChanged(qtyChanged),
    },
  ];

  it.each(cases)(
    'mirrors $name onto ris.events alongside the primary emit',
    async ({ routingKey, event, invoke }) => {
      await invoke();

      expect(retailEmit).toHaveBeenCalledWith(routingKey, event);
      expect(mirrorSpy).toHaveBeenCalledTimes(1);
      expect(mirrorSpy).toHaveBeenCalledWith(routingKey, event);
    },
  );

  it('does not throw out of a publish method when the ris.events mirror fails', async () => {
    mirrorEmit.mockReturnValue(throwError(() => new Error('ris.events down')));

    await expect(publisher.publishCartCreated(created)).resolves.toBeUndefined();
    expect(retailEmit).toHaveBeenCalledTimes(1);
  });
});
