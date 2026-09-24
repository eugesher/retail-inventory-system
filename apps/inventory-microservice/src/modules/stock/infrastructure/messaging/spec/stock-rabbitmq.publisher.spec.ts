import { ClientProxy } from '@nestjs/microservices';
import { PinoLogger } from 'nestjs-pino';
import { of, throwError } from 'rxjs';

import { StockMovementTypeEnum } from '@retail-inventory-system/contracts';
import { RisEventsMirrorPublisher, ROUTING_KEYS } from '@retail-inventory-system/messaging';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import {
  StockAdjustedEvent,
  StockAllocatedEvent,
  StockCommittedEvent,
  StockLevelInitializedEvent,
  StockLowEvent,
  StockMovement,
  StockReceivedEvent,
  StockReleasedEvent,
  StockReservedEvent,
  StockReturnedEvent,
} from '../../../domain';
import { StockRabbitmqPublisher } from '../stock-rabbitmq.publisher';

describe('StockRabbitmqPublisher dual-publish', () => {
  let notificationEmit: jest.Mock;
  let inventoryEmit: jest.Mock;
  let mirrorEmit: jest.Mock;
  let mirror: RisEventsMirrorPublisher;
  let mirrorSpy: jest.SpyInstance;
  let publisher: StockRabbitmqPublisher;

  beforeEach(() => {
    notificationEmit = jest.fn().mockReturnValue(of(undefined));
    inventoryEmit = jest.fn().mockReturnValue(of(undefined));
    mirrorEmit = jest.fn().mockReturnValue(of(undefined));

    mirror = new RisEventsMirrorPublisher(
      { emit: mirrorEmit } as unknown as ClientProxy,
      makePinoLoggerMock() as unknown as PinoLogger,
    );
    mirrorSpy = jest.spyOn(mirror, 'mirror');

    publisher = new StockRabbitmqPublisher(
      { emit: notificationEmit } as unknown as ClientProxy,
      { emit: inventoryEmit } as unknown as ClientProxy,
      mirror,
    );
  });

  const movement = {
    id: 99,
    variantId: 7,
    stockLocationId: 'default-warehouse',
    type: StockMovementTypeEnum.RECEIPT,
    quantity: 5,
    reasonCode: null,
    referenceType: null,
    referenceId: null,
    actorId: 'staff-1',
    occurredAt: new Date('2026-06-27T10:00:00.000Z'),
  } as unknown as StockMovement;

  interface ICase {
    name: string;
    routingKey: string;
    primary: () => jest.Mock;
    invoke: () => Promise<void>;
  }

  const cases: ICase[] = [
    {
      name: 'stock.low',
      routingKey: ROUTING_KEYS.INVENTORY_STOCK_LOW,
      primary: () => notificationEmit,
      invoke: () =>
        publisher.publishStockLow(
          new StockLowEvent({ variantId: 7, stockLocationId: 'w', quantity: 1, threshold: 5 }),
          'cid',
        ),
    },
    {
      name: 'stock.received',
      routingKey: ROUTING_KEYS.INVENTORY_STOCK_RECEIVED,
      primary: () => inventoryEmit,
      invoke: () =>
        publisher.publishStockReceived(
          new StockReceivedEvent({
            variantId: 7,
            stockLocationId: 'w',
            quantityDelta: 5,
            newOnHand: 5,
          }),
          'cid',
        ),
    },
    {
      name: 'stock.adjusted',
      routingKey: ROUTING_KEYS.INVENTORY_STOCK_ADJUSTED,
      primary: () => inventoryEmit,
      invoke: () =>
        publisher.publishStockAdjusted(
          new StockAdjustedEvent({
            variantId: 7,
            stockLocationId: 'w',
            quantityDelta: -2,
            reasonCode: 'shrinkage',
            newOnHand: 3,
          }),
          'cid',
        ),
    },
    {
      name: 'stock-level.initialized',
      routingKey: ROUTING_KEYS.INVENTORY_STOCK_LEVEL_INITIALIZED,
      primary: () => inventoryEmit,
      invoke: () =>
        publisher.publishStockLevelInitialized(
          new StockLevelInitializedEvent({ variantId: 7, stockLocationId: 'w' }),
          'cid',
        ),
    },
    {
      name: 'stock.reserved',
      routingKey: ROUTING_KEYS.INVENTORY_STOCK_RESERVED,
      primary: () => inventoryEmit,
      invoke: () =>
        publisher.publishStockReserved(
          new StockReservedEvent({
            variantId: 7,
            stockLocationId: 'w',
            quantity: 2,
            cartId: 'cart-1',
            reservationId: 'res-1',
            expiresAt: new Date('2026-06-27T10:15:00.000Z'),
          }),
          'cid',
        ),
    },
    {
      name: 'stock.allocated',
      routingKey: ROUTING_KEYS.INVENTORY_STOCK_ALLOCATED,
      primary: () => inventoryEmit,
      invoke: () =>
        publisher.publishStockAllocated(
          new StockAllocatedEvent({
            variantId: 7,
            stockLocationId: 'w',
            quantity: 2,
            orderId: 11,
            reservationId: 'res-1',
          }),
          'cid',
        ),
    },
    {
      name: 'stock.released',
      routingKey: ROUTING_KEYS.INVENTORY_STOCK_RELEASED,
      primary: () => inventoryEmit,
      invoke: () =>
        publisher.publishStockReleased(
          new StockReleasedEvent({
            variantId: 7,
            stockLocationId: 'w',
            quantity: 2,
            cartId: 'cart-1',
            reservationId: 'res-1',
            reason: 'manual',
          }),
          'cid',
        ),
    },
    {
      name: 'stock.committed',
      routingKey: ROUTING_KEYS.INVENTORY_STOCK_COMMITTED,
      primary: () => inventoryEmit,
      invoke: () =>
        publisher.publishStockCommitted(
          new StockCommittedEvent({
            variantId: 7,
            stockLocationId: 'w',
            quantity: 2,
            orderId: 11,
            fulfillmentId: 'ful-1',
          }),
          'cid',
        ),
    },
    {
      name: 'stock.returned',
      routingKey: ROUTING_KEYS.INVENTORY_STOCK_RETURNED,
      primary: () => inventoryEmit,
      invoke: () =>
        publisher.publishStockReturned(
          new StockReturnedEvent({
            variantId: 7,
            stockLocationId: 'w',
            quantity: 2,
            returnRequestId: 21,
            returnLineId: 31,
          }),
          'cid',
        ),
    },
    {
      name: 'stock-movement.recorded',
      routingKey: ROUTING_KEYS.INVENTORY_STOCK_MOVEMENT_RECORDED,
      primary: () => inventoryEmit,
      invoke: () => publisher.publishStockMovementRecorded(movement, 'cid'),
    },
  ];

  it.each(cases)(
    'mirrors $name onto ris.events with the same routing key + wire as the primary emit',
    async ({ routingKey, primary, invoke }) => {
      await invoke();

      const primaryEmit = primary();
      expect(primaryEmit).toHaveBeenCalledTimes(1);
      const [primaryKey, primaryWire] = primaryEmit.mock.calls[0] as [string, unknown];
      expect(primaryKey).toBe(routingKey);

      expect(mirrorSpy).toHaveBeenCalledTimes(1);
      const [mirrorKey, mirrorWire] = mirrorSpy.mock.calls[0] as [string, unknown];
      expect(mirrorKey).toBe(routingKey);
      expect(mirrorWire).toBe(primaryWire);
    },
  );

  it('orders the mirror after the primary emit', async () => {
    const order: string[] = [];
    inventoryEmit.mockImplementation(() => {
      order.push('primary');
      return of(undefined);
    });
    mirrorEmit.mockImplementation(() => {
      order.push('mirror');
      return of(undefined);
    });

    await publisher.publishStockReceived(
      new StockReceivedEvent({
        variantId: 7,
        stockLocationId: 'w',
        quantityDelta: 5,
        newOnHand: 5,
      }),
    );

    expect(order).toEqual(['primary', 'mirror']);
  });

  it('does not throw out of a publish method when the ris.events mirror fails', async () => {
    mirrorEmit.mockReturnValue(throwError(() => new Error('ris.events down')));

    await expect(
      publisher.publishStockReceived(
        new StockReceivedEvent({
          variantId: 7,
          stockLocationId: 'w',
          quantityDelta: 5,
          newOnHand: 5,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(inventoryEmit).toHaveBeenCalledTimes(1);
  });
});
