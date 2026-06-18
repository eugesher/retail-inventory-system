import { PinoLogger } from 'nestjs-pino';

import { IAllocationCancelPayload } from '@retail-inventory-system/contracts';

import { IOrderInventoryGatewayPort } from '../ports';
import { retryThenLogForReplay } from './retry-then-log-for-replay';

// How many times the allocation release is attempted before the failure is logged for
// operator replay. Cancel-Allocation is the inverse of Allocate and idempotent-ish
// inventory-side (`releaseAllocated` only rejects an over-release), so a retry is safe.
export const CANCEL_ALLOCATION_MAX_ATTEMPTS = 3;

// Releases an order's (or a single line's) stock allocation against the inventory
// reservation surface (`inventory.allocation.cancel`) under the shared post-commit
// retry/log-for-replay posture (`retryThenLogForReplay`). On a persistent failure the
// local cancellation stays committed and the release awaits operator replay — a failed
// release over-holds the stock until manual intervention frees it, but never corrupts the
// counters. Shared by Cancel Order and Cancel Line.
export async function releaseAllocationWithRetry(
  gateway: IOrderInventoryGatewayPort,
  payload: IAllocationCancelPayload,
  logger: PinoLogger,
  correlationId: string,
): Promise<void> {
  await retryThenLogForReplay(() => gateway.cancelAllocation(payload), {
    maxAttempts: CANCEL_ALLOCATION_MAX_ATTEMPTS,
    logger,
    correlationId,
    label: 'Cancel-Allocation',
    context: { orderId: payload.orderId, reason: payload.reason, lines: payload.lines },
    replayMessage:
      'Cancel-Allocation failed after retries; the cancellation is committed and the stock release awaits operator replay (over-holds until then, never corrupts)',
  });
}
