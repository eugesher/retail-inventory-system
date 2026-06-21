import {
  IInventoryStockLowEvent,
  NotificationChannelEnum,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { RenderAndDispatchUseCase } from '../../../application/use-cases';
import { InventoryEventsConsumer } from '../inventory-events.consumer';
import { RecordingRenderAndDispatch } from './test-doubles';

const OPS_EMAIL = 'ops@example.com';

describe('InventoryEventsConsumer', () => {
  let renderAndDispatch: RecordingRenderAndDispatch;
  let consumer: InventoryEventsConsumer;

  beforeEach(() => {
    renderAndDispatch = new RecordingRenderAndDispatch();
    consumer = new InventoryEventsConsumer(
      OPS_EMAIL,
      renderAndDispatch as unknown as RenderAndDispatchUseCase,
    );
  });

  const buildEvent = (
    overrides: Partial<IInventoryStockLowEvent> = {},
  ): IInventoryStockLowEvent => ({
    correlationId: 'corr-low-1',
    variantId: 77,
    stockLocationId: 'default-warehouse',
    quantity: 2,
    threshold: 5,
    eventVersion: 'v1',
    occurredAt: '2026-06-10T12:00:00.000Z',
    ...overrides,
  });

  it('routes a low-stock alert to the ops mailbox as a null-recipient system row', async () => {
    await consumer.onStockLow(buildEvent());

    expect(renderAndDispatch.inputs).toHaveLength(1);
    expect(renderAndDispatch.inputs[0]).toEqual({
      eventType: ROUTING_KEYS.INVENTORY_STOCK_LOW,
      channel: NotificationChannelEnum.EMAIL,
      recipientCustomerId: null,
      recipientAddress: OPS_EMAIL,
      eventReferenceType: 'stock-low',
      eventReferenceId: '77:default-warehouse',
      context: buildEvent(),
      correlationId: 'corr-low-1',
    });
  });

  it('keys the reference id on the (variantId, stockLocationId) pair', async () => {
    await consumer.onStockLow(buildEvent({ variantId: 9, stockLocationId: 'store-1' }));

    expect(renderAndDispatch.inputs[0].eventReferenceId).toBe('9:store-1');
  });
});
