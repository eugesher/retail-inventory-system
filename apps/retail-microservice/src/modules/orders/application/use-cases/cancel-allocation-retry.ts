import { randomUUID } from 'crypto';

import { PinoLogger } from 'nestjs-pino';

import { retryThenLogForReplay } from '@retail-inventory-system/common';
import { IAllocationCancelPayload } from '@retail-inventory-system/contracts';

import { IOrderInventoryGatewayPort } from '../ports';

// How many times the allocation release is attempted before the failure is logged for
// operator replay. Retries are immediate — no backoff.
//
// **The bound is a latency budget, not a safety one** (the `COMMIT_SALE_MAX_ATTEMPTS` /
// `RESTOCK_MAX_ATTEMPTS` framing). Every caller awaits this inside its own HTTP request —
// `cancel` does not return until this does — so a larger count only holds that caller open
// against a broker that is already down. Three ride out a broker blip; the poison-record log
// covers the rest.
//
// What makes a *retry* safe is not this number but the `operationKey` below (ADR-057).
export const CANCEL_ALLOCATION_MAX_ATTEMPTS = 3;

// Releases an order's (or a single line's) stock allocation against the inventory
// reservation surface (`inventory.allocation.cancel`) under the shared post-commit
// retry/log-for-replay posture (`retryThenLogForReplay`). On a persistent failure the
// local cancellation stays committed and the release awaits operator replay — a failed
// release over-holds the stock until manual intervention frees it, but never corrupts the
// counters. Shared by Cancel Order and Cancel Line.
//
// **This function mints the cancellation's identity, and the placement is the point**
// (ADR-057). `operationKey` is generated HERE — once, before the retry loop — so every
// attempt inside `retryThenLogForReplay`, and every broker redelivery of the resulting RPC,
// carries the same value, while a genuinely separate cancellation gets a different one.
// Generating it inside the loop, or inventory-side, would defeat it entirely: the whole
// purpose is that a redelivery is *recognisable*, and it is only recognisable if the sender
// decided its identity before it started sending.
//
// It is a UUID rather than something derived from `(orderId, lineId, quantity)` because no
// tuple of those is unique: ADR-040 made partial line cancellation a first-class operation,
// so cancelling 2 units of a line today and 2 more tomorrow are two legitimate operations
// with identical parameters. A derived key would collapse them and silently drop the second
// release.
//
// A retry of the whole HTTP request is a different case and is already handled upstream:
// `order_line.cancelled_quantity` makes the second request cancel zero units, so it sends no
// release at all (ADR-040).
//
// The key rides `context`, so the poison-record an operator replays from carries the identity
// that makes the replay safe.
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
