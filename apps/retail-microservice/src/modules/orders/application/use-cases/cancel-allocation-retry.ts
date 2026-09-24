import { randomUUID } from 'crypto';

import { PinoLogger } from 'nestjs-pino';

import { retryThenLogForReplay } from '@retail-inventory-system/common';
import { IAllocationCancelPayload } from '@retail-inventory-system/contracts';

import { IOrderInventoryGatewayPort } from '../ports';

export const CANCEL_ALLOCATION_MAX_ATTEMPTS = 3;

export async function releaseAllocationWithRetry(
  gateway: IOrderInventoryGatewayPort,
  payload: Omit<IAllocationCancelPayload, 'operationKey'>,
  logger: PinoLogger,
  correlationId: string,
): Promise<void> {
  const keyed: IAllocationCancelPayload = { ...payload, operationKey: randomUUID() };

  await retryThenLogForReplay(() => gateway.cancelAllocation(keyed), {
    maxAttempts: CANCEL_ALLOCATION_MAX_ATTEMPTS,
    logger,
    correlationId,
    label: 'Cancel-Allocation',
    context: {
      orderId: keyed.orderId,
      reason: keyed.reason,
      lines: keyed.lines,
      operationKey: keyed.operationKey,
    },
    replayMessage:
      'Cancel-Allocation failed after retries; the cancellation is committed and the stock release awaits operator replay (over-holds until then, never corrupts — replay with the logged operationKey so it stays idempotent)',
  });
}
