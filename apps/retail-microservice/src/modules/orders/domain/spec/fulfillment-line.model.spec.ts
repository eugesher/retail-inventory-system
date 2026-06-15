import { FulfillmentLine, OrderDomainException, OrderErrorCodeEnum } from '..';

describe('FulfillmentLine', () => {
  it('builds a valid line and exposes its fields', () => {
    const line = new FulfillmentLine({
      id: null,
      fulfillmentId: null,
      orderLineId: 10,
      quantity: 3,
    });

    expect(line.id).toBeNull();
    expect(line.fulfillmentId).toBeNull();
    expect(line.orderLineId).toBe(10);
    expect(line.quantity).toBe(3);
  });

  it('carries a concrete id + parent id on the load path', () => {
    const line = new FulfillmentLine({
      id: 7,
      fulfillmentId: 5,
      orderLineId: 10,
      quantity: 1,
    });

    expect(line.id).toBe(7);
    expect(line.fulfillmentId).toBe(5);
  });

  it.each([
    ['zero', 0],
    ['negative', -2],
    ['fractional', 1.5],
  ])('rejects a %s quantity with FULFILLMENT_LINE_QUANTITY_INVALID', (_label, quantity) => {
    try {
      new FulfillmentLine({ id: null, fulfillmentId: null, orderLineId: 10, quantity });
      fail('expected the FulfillmentLine constructor to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(OrderDomainException);
      expect((err as OrderDomainException).code).toBe(
        OrderErrorCodeEnum.FULFILLMENT_LINE_QUANTITY_INVALID,
      );
    }
  });
});
