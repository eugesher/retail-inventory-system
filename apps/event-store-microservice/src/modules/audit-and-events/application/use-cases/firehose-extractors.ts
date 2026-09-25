import { AppNameEnum } from '@retail-inventory-system/contracts';

const PRODUCER_BY_PREFIX: Readonly<Record<string, string>> = {
  inventory: AppNameEnum.INVENTORY_MICROSERVICE,
  retail: AppNameEnum.RETAIL_MICROSERVICE,
  catalog: AppNameEnum.CATALOG_MICROSERVICE,
  notification: AppNameEnum.NOTIFICATION_MICROSERVICE,
  notifications: AppNameEnum.NOTIFICATION_MICROSERVICE,
};

export function resolveProducer(tokens: readonly string[]): string {
  const prefix = tokens[0] ?? '';
  return PRODUCER_BY_PREFIX[prefix] ?? prefix;
}

export function resolveAggregateType(tokens: readonly string[]): string {
  return tokens[1] ?? '';
}

export const AGGREGATE_ID_KEYS: readonly string[] = [
  'aggregateId',
  'id',
  'orderId',
  'variantId',
  'cartId',
  'reservationId',
  'fulfillmentId',
  'returnRequestId',
  'returnLineId',
  'paymentId',
  'refundId',
  'movementId',
  'deliveryId',
  'templateId',
  'stockLocationId',
];

export function resolveAggregateId(payload: Record<string, unknown>): string {
  for (const key of AGGREGATE_ID_KEYS) {
    const value = payload[key];
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
      return value.toString();
    }
  }
  return '';
}
