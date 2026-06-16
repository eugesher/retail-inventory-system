import { PinoLogger } from 'nestjs-pino';

import { IAllocationCancelPayload } from '@retail-inventory-system/contracts';

import { IOrderInventoryGatewayPort } from '../ports';

// How many times the allocation release is attempted before the failure is logged for
// operator replay. Cancel-Allocation is the inverse of Allocate and idempotent-ish
// inventory-side (`releaseAllocated` only rejects an over-release), so a retry is safe.
// Retries are immediate (no backoff) — the realistic failure is a transient RMQ hiccup
// the broker recovers from; a backoff is a later refinement (the Ship Commit-Sale
// posture).
export const CANCEL_ALLOCATION_MAX_ATTEMPTS = 3;

// Releases an order's (or a single line's) stock allocation against the inventory
// reservation surface (`inventory.allocation.cancel`), retrying a bounded number of
// times. On a persistent failure it logs the full payload at `error` (a poison record
// for operator replay) and returns **WITHOUT throwing**: the local cancellation has
// already committed and must not be rolled back (eventual consistency on the inventory
// release, the same posture Ship's Commit Sale uses, ADR-031). A failed release
// over-holds the stock until a manual intervention frees it — it never corrupts the
// counters. Shared by Cancel Order and Cancel Line so the retry/log-replay posture
// lives in exactly one place (the `order-access` shared-helper precedent).
export async function releaseAllocationWithRetry(
  gateway: IOrderInventoryGatewayPort,
  payload: IAllocationCancelPayload,
  logger: PinoLogger,
  correlationId: string,
): Promise<void> {
  for (let attempt = 1; attempt <= CANCEL_ALLOCATION_MAX_ATTEMPTS; attempt++) {
    try {
      await gateway.cancelAllocation(payload);
      return;
    } catch (error) {
      if (attempt < CANCEL_ALLOCATION_MAX_ATTEMPTS) {
        logger.warn(
          { err: error as Error, correlationId, attempt, orderId: payload.orderId },
          'Cancel-Allocation failed — retrying',
        );
        continue;
      }
      logger.error(
        {
          err: error as Error,
          correlationId,
          orderId: payload.orderId,
          reason: payload.reason,
          lines: payload.lines,
        },
        'Cancel-Allocation failed after retries; the cancellation is committed and the stock release awaits operator replay (over-holds until then, never corrupts)',
      );
    }
  }
}
