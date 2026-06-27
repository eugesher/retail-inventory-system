import {
  AGGREGATE_ID_KEYS,
  resolveAggregateId,
  resolveAggregateType,
  resolveProducer,
} from '../firehose-extractors';

describe('firehose-extractors', () => {
  describe('resolveProducer', () => {
    it.each([
      ['inventory.stock.low', 'inventory-microservice'],
      ['retail.order.placed', 'retail-microservice'],
      ['catalog.variant.created', 'catalog-microservice'],
      ['notification.template.author', 'notification-microservice'],
      ['notifications.delivery.failed', 'notification-microservice'],
    ])('maps the first routing-key token of %s to %s', (routingKey, expected) => {
      expect(resolveProducer(routingKey)).toBe(expected);
    });

    it('falls back to the raw first token for an unmapped producer prefix', () => {
      expect(resolveProducer('payments.charge.captured')).toBe('payments');
    });

    it('falls back to the empty string for an empty routing key', () => {
      expect(resolveProducer('')).toBe('');
    });
  });

  describe('resolveAggregateType', () => {
    it.each([
      ['retail.order.placed', 'order'],
      ['inventory.stock-movement.recorded', 'stock-movement'],
      ['inventory.stock-level.initialized', 'stock-level'],
      ['catalog.variant.created', 'variant'],
    ])('returns the second routing-key token of %s as %s', (routingKey, expected) => {
      expect(resolveAggregateType(routingKey)).toBe(expected);
    });

    it('falls back to the empty string when there is no second token', () => {
      expect(resolveAggregateType('audit')).toBe('');
    });
  });

  describe('resolveAggregateId', () => {
    it('prefers an explicit aggregateId over every other key', () => {
      expect(resolveAggregateId({ aggregateId: 'agg-1', id: 9, orderId: 42 })).toBe('agg-1');
    });

    it('uses the generic id when aggregateId is absent', () => {
      expect(resolveAggregateId({ id: 9, orderId: 42 })).toBe('9');
    });

    it('walks the precedence list to the first present per-aggregate id', () => {
      expect(resolveAggregateId({ orderId: 42 })).toBe('42');
      expect(resolveAggregateId({ variantId: 7 })).toBe('7');
      expect(resolveAggregateId({ cartId: 'c-uuid' })).toBe('c-uuid');
      expect(resolveAggregateId({ reservationId: 'r-uuid' })).toBe('r-uuid');
    });

    it('stringifies a numeric BIGINT id', () => {
      expect(resolveAggregateId({ orderId: 123456789 })).toBe('123456789');
    });

    it('skips null/undefined values and takes the next present key', () => {
      expect(resolveAggregateId({ aggregateId: null, id: undefined, orderId: 5 })).toBe('5');
    });

    it('falls back to the empty string when no known id key is present', () => {
      expect(resolveAggregateId({ unrelated: 'x' })).toBe('');
      expect(resolveAggregateId({})).toBe('');
    });

    it('exposes the precedence list, aggregateId first', () => {
      expect(AGGREGATE_ID_KEYS[0]).toBe('aggregateId');
      expect(AGGREGATE_ID_KEYS[1]).toBe('id');
      expect(AGGREGATE_ID_KEYS).toContain('returnRequestId');
    });
  });
});
