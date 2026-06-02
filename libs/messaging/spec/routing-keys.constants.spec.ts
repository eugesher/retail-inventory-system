import { MicroserviceMessagePatternEnum } from '@retail-inventory-system/contracts';

import { ROUTING_KEYS } from '../routing-keys.constants';

// Wire-format alignment: the `ROUTING_KEYS` constants in `libs/messaging` and
// the `MicroserviceMessagePatternEnum` values in `libs/contracts` must agree
// — both libraries are imported by gateway and microservices and a drift
// would silently route messages to the wrong queue.
describe('ROUTING_KEYS', () => {
  it('matches MicroserviceMessagePatternEnum values', () => {
    expect(ROUTING_KEYS.RETAIL_ORDER_CREATE).toBe(
      MicroserviceMessagePatternEnum.RETAIL_ORDER_CREATE,
    );
    expect(ROUTING_KEYS.RETAIL_ORDER_CONFIRM).toBe(
      MicroserviceMessagePatternEnum.RETAIL_ORDER_CONFIRM,
    );
    expect(ROUTING_KEYS.RETAIL_ORDER_GET).toBe(MicroserviceMessagePatternEnum.RETAIL_ORDER_GET);
    expect(ROUTING_KEYS.RETAIL_ORDER_CREATED).toBe(
      MicroserviceMessagePatternEnum.RETAIL_ORDER_CREATED,
    );
    expect(ROUTING_KEYS.RETAIL_ORDER_CONFIRMED).toBe(
      MicroserviceMessagePatternEnum.RETAIL_ORDER_CONFIRMED,
    );
    expect(ROUTING_KEYS.RETAIL_ORDER_CANCELLED).toBe(
      MicroserviceMessagePatternEnum.RETAIL_ORDER_CANCELLED,
    );
    expect(ROUTING_KEYS.INVENTORY_PRODUCT_STOCK_GET).toBe(
      MicroserviceMessagePatternEnum.INVENTORY_PRODUCT_STOCK_GET,
    );
    expect(ROUTING_KEYS.INVENTORY_ORDER_CONFIRM).toBe(
      MicroserviceMessagePatternEnum.INVENTORY_ORDER_CONFIRM,
    );
    expect(ROUTING_KEYS.INVENTORY_STOCK_LOW).toBe(
      MicroserviceMessagePatternEnum.INVENTORY_STOCK_LOW,
    );
    expect(ROUTING_KEYS.CATALOG_PRODUCT_REGISTER).toBe(
      MicroserviceMessagePatternEnum.CATALOG_PRODUCT_REGISTER,
    );
    expect(ROUTING_KEYS.CATALOG_PRODUCT_PUBLISH).toBe(
      MicroserviceMessagePatternEnum.CATALOG_PRODUCT_PUBLISH,
    );
    expect(ROUTING_KEYS.CATALOG_PRODUCT_ARCHIVE).toBe(
      MicroserviceMessagePatternEnum.CATALOG_PRODUCT_ARCHIVE,
    );
    expect(ROUTING_KEYS.CATALOG_VARIANT_CREATE).toBe(
      MicroserviceMessagePatternEnum.CATALOG_VARIANT_CREATE,
    );
    expect(ROUTING_KEYS.CATALOG_VARIANT_CREATED).toBe(
      MicroserviceMessagePatternEnum.CATALOG_VARIANT_CREATED,
    );
    expect(ROUTING_KEYS.CATALOG_PRODUCT_PUBLISHED).toBe(
      MicroserviceMessagePatternEnum.CATALOG_PRODUCT_PUBLISHED,
    );
    expect(ROUTING_KEYS.CATALOG_PRODUCT_ARCHIVED).toBe(
      MicroserviceMessagePatternEnum.CATALOG_PRODUCT_ARCHIVED,
    );
    expect(ROUTING_KEYS.NOTIFICATION_HEALTH_PING).toBe(
      MicroserviceMessagePatternEnum.NOTIFICATION_HEALTH_PING,
    );
  });

  it('uses dotted naming convention', () => {
    for (const value of Object.values(ROUTING_KEYS)) {
      expect(value).toMatch(/^[a-z]+(\.[a-z-]+)+$/);
    }
  });
});
