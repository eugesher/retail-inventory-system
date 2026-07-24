import { NotificationDelivery } from '../../domain';
import { NotificationDeliveryStatusEnum } from '@retail-inventory-system/contracts';

// How long a delivery may sit in `queued` before the system treats it as ORPHANED rather
// than in-flight.
//
// **Why an orphan is possible at all.** The Render & Dispatch pipeline is persist-then-send
// (ADR-033): the row commits `queued`, then the `NOTIFIER` is called, then the row is flipped
// `sent`/`failed`. Anything that kills the process — or merely makes that *second* save
// fail — leaves the row at `queued` with nobody coming back for it. The second case is the
// likelier one and is worth spelling out: if the final `deliveryRepo.save` throws, the
// exception escapes the `@EventPattern` consumer and RabbitMQ redelivers the event, but the
// redelivery hits the dedupe pre-check, finds the `queued` row, and returns it WITHOUT
// dispatching. The one path that looked like a second chance is the path that closes the door.
//
// ADR-033 §3 already decided what should happen: *"a crash mid-send then still leaves an
// auditable row **the retry sweeper can pick up**."* It did not pick it up — `listRetryable`
// scanned `failed` only, and the manual retry refused anything that was not `failed`. So an
// orphan was unreachable by **every** path, automatic and human alike. This constant is what
// makes the ADR's sentence true.
//
// **Why a threshold rather than "any queued row".** A row persisted milliseconds ago is being
// dispatched *right now*, in this process or another replica. Re-dispatching that is not
// recovery, it is a race the sweeper would lose half the time. The threshold is a safety
// margin around the longest plausible `NOTIFIER.send`, not an operational tuning knob — five
// minutes is far past any transport call (there is no timeout on `send`, so "far past" is the
// only bound available) while still bounding how long a genuinely lost notification stays
// lost. It is a module constant, like `RETRY_BACKOFF_BASE_MS` and `SWEEP_BATCH_SIZE`
// next door, for that reason: it is not a value an operator should be tuning.
//
// **The double-send this accepts, stated once.** A rescued row is indistinguishable from
// the outside: the send may have succeeded and only the status write been lost, in which
// case re-dispatching sends a second copy. That trade is not new here — it is the one
// persist-then-send was chosen for, on the reasoning that a possible duplicate is far
// cheaper than a possible silent drop. Leaving the row unreachable took the cost of that
// trade without ever collecting the benefit.
export const QUEUED_STALE_AFTER_MS = 5 * 60 * 1_000;

// The `created_at` horizon a `queued` row must predate to count as orphaned. The repository
// scan takes it as a bound so the staleness filter runs in SQL rather than over a fetched
// batch; the manual-retry guard compares against it directly.
export const staleQueuedHorizon = (now: Date): Date =>
  new Date(now.getTime() - QUEUED_STALE_AFTER_MS);

// Whether one loaded delivery is an orphaned `queued` row — the manual-retry guard's half of
// the rule above. A `createdAt` of `null` is treated as NOT stale: a persisted row always has
// one (`BaseEntity`), so a null means something unexpected, and the safe reading of "I do not
// know how old this is" is to leave it alone.
export const isOrphanedQueued = (delivery: NotificationDelivery, now: Date): boolean =>
  delivery.status === NotificationDeliveryStatusEnum.QUEUED &&
  delivery.createdAt !== null &&
  delivery.createdAt.getTime() < staleQueuedHorizon(now).getTime();
