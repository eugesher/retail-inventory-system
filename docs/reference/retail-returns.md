# Retail returns

What the retail `returns` module (`apps/retail-microservice/src/modules/returns/`) does today, beyond
what its names and types say: the `ReturnRequest` (RMA) aggregate, who may drive it, the Open and
Inspect use cases, and how they fail. Paths below are relative to that folder unless they start at
the repository root. The rationale lives in the ADRs:
[ADR-032](../adr/032-returns-and-refunds-rma-lifecycle-and-restock.md) (the lifecycle, the window
and the restock), [ADR-051](../adr/051-refusing-a-resource-you-do-not-own.md) (a `403`, never an
empty list), [ADR-063](../adr/063-unit-of-work-for-stock-orders-returns.md) (the unit of work every
write goes through), [ADR-033](../adr/033-notification-templates-deliveries-and-render-dispatch.md)
(the email carried on an event), and [ADR-056](../adr/056-lifting-the-post-commit-retry-helper.md),
whose test explains why the module keeps local copies of `orders/` code (a helper whose signature
names a module-owned type stays in its module). Payload and view rules are in
[`wire-contracts.md`](wire-contracts.md#retail--returns); the code-to-status table is
`presentation/return-rpc-exception.filter.ts`.

## The `ReturnRequest` aggregate

- **The RMA number is written by a second statement.** The row is inserted with a `NULL`
  `rma_number`, and an `UPDATE` then sets `RMA-<year>-<pad8(id)>` from the generated id. `<year>` is
  the UTC year of `requestedAt`
  (`infrastructure/persistence/return-request-write-typeorm.repository.ts`,
  `ReturnRequestWriteTypeormRepository.persistGraph`). The column is nullable only to allow that
  insert. The `UPDATE` also advances the version, as every TypeORM `Repository.update` does
  ([`retail-orders.md`](retail-orders.md#reads-locks-and-versions)), so a newly opened RMA is already
  past its insert version.
- **A rejection reason goes into `notes`.** It is trimmed and appended as `Rejected: <reason>`, on a
  new line after the buyer's note when there is one. A blank reason appends nothing
  (`domain/return-request.model.ts`, `ReturnRequest.reject`). The reason also rides
  `retail.return.rejected`.
- **A line can be inspected once only because of its parent's status.** `ReturnLine.inspect`
  overwrites the three inspection fields whenever it is called. What stops a second inspection is
  `ReturnRequest.markInspected`, which accepts only `received`, in the same unit of work.
- **`lineRefundAmountMinor` is a number recorded and never used.** Inspect checks only that it is a
  non-negative integer, not that it stays within what the line cost. Nothing reads it back:
  - Close moves no money.
  - `IssueRefundUseCase` in `orders/` takes its amount from the caller, and nothing in `orders/`
    reads `return_line`.

  A refund for a return is a separate staff call.

## Who may call what

| Operation                                  | Retail-side check                                                                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open                                       | the order exists (`RETURN_ORDER_NOT_FOUND`), then the caller owns the **order**, unless `isStaff` (`RETURN_ACCESS_FORBIDDEN`)                                  |
| List for an order                          | the same two checks, against the order, before any RMA row is read (`application/use-cases/list-returns.use-case.ts`)                                          |
| Get                                        | the RMA exists (`RETURN_NOT_FOUND`), then the caller is the RMA's `customerId`, unless `isStaff` (`application/use-cases/return-access.ts`, `loadOwnedReturn`) |
| Authorize, Reject, Receive, Inspect, Close | the RMA exists; nothing else. The permission gate is the gateway's alone (`loadReturnById`)                                                                    |

- **Staff opens on the buyer's behalf.** The RMA's `customerId` is the order's `customer_id`, not the
  caller's, so the buyer can read it afterwards.
- **Retail records no staff actor for Authorize, Reject, Receive or Close.** Their `actorId` is logged
  and nothing more: it is not on the row, not on the event, and no audit entry is written. Inspect's
  `actorId` travels on the restock RPC, and inventory writes it onto the `return` stock movement.

## Open Return Request

`application/use-cases/open-return-request.use-case.ts`, `OpenReturnRequestUseCase.execute`.

- **Order of checks:** the order exists → the caller may open on it → the return window → for each
  requested line, in payload order: the line belongs to the order (`404 RETURN_ORDER_LINE_NOT_FOUND`),
  then the quantity is returnable (`409 RETURN_QUANTITY_EXCEEDS_RETURNABLE`). The first rejection
  wins.
- **The window reads the order's fulfillment status and nothing else**
  (`OpenReturnRequestUseCase.assertWithinReturnWindow`). The order `status` is not consulted.
  - `delivered`: always returnable, with no window at all.
  - `shipped` or `partially-shipped`: returnable while `now ≤ shippedAt + RETURN_WINDOW_DAYS × 24 h`.
    `shippedAt` is the order's **first** shipment, `MIN(fulfillment.shipped_at)`. If no fulfillment
    has a `shipped_at`, the latest `delivered_at` stands in for it, and with neither the order is not
    returnable.
  - anything else: `409 RETURN_ORDER_NOT_RETURNABLE`.

  Because the window starts at the first shipment, goods from a later shipment get only what is left
  of it.

- **Returnable quantity is `ordered − cancelled_quantity − already returned`.** "Already returned"
  sums the lines of every RMA on the order except `rejected` ones, whatever their status, including
  `closed` (`OpenReturnRequestUseCase.sumAlreadyReturnedByLine`).
- **Each requested line is checked on its own against that remainder.** A request that lists one
  order line twice passes when each entry fits alone. Neither the gateway DTO nor `return_line` has a
  uniqueness rule (see [Failure modes](#failure-modes)).
- **The reads happen outside the write's transaction, without a lock.** The order comes from
  `RETURN_ORDER_READER`, and the other RMAs from the plain read port on the default connection. The
  insert runs in its own unit of work afterwards.
- **The order reader filters `deleted_at IS NULL` on `order`, `order_line` and `fulfillment`**
  (`infrastructure/persistence/return-order-reader-typeorm.adapter.ts`,
  `ReturnOrderReaderTypeormAdapter.findOrderForReturn`). A soft-deleted order reads as missing.

## Lifecycle transitions

- **Authorize, Reject, Receive and Close read, then write in a separate unit of work.** Each attempt
  loads the RMA off the plain read port, applies the transition, and saves with the version it read.
  A lost compare-and-swap reruns the attempt from a fresh read. A domain rejection
  (`RETURN_INVALID_STATUS_TRANSITION`) propagates at once and is never retried. Authorize does not
  re-check the window or the quantities.
- **A lost compare-and-swap reports the version the winner left.** The write repository reads it
  through the default connection's manager, not the transaction that lost. That transaction's
  `REPEATABLE READ` snapshot predates the winner's commit
  (`ReturnRequestWriteTypeormRepository.save`).
- **Every save rewrites all the lines**, not only the ones that changed. That is how Inspect's
  per-line fields reach the table.

## Inspect and Disposition

`application/use-cases/inspect-and-disposition.use-case.ts`, `InspectAndDispositionUseCase.execute`.

- **The inspection set is validated before the status.** Against the RMA loaded before the unit of
  work, three checks run:
  - every entry names one of its lines (`404 RETURN_LINE_NOT_FOUND`);
  - no line appears twice (`400 RETURN_INSPECTION_INVALID`);
  - every line is covered (`400 RETURN_INSPECTION_INVALID`).

  Only then does the unit of work run `markInspected`. An RMA that is not `received` therefore
  answers `400` to an incomplete set, and `409` only to a complete one.

- **The whole inspection is one unit of work, retried as a whole.** Each attempt re-reads the RMA
  inside the unit of work, records every line, walks `received → inspected`, and saves with the
  version it read.
- **`inspectedAt` on the event is taken before the unit of work starts.** No column stores it.
- **The restock runs after the commit, for the `restock` lines only**
  (`InspectAndDispositionUseCase.restockFitForResaleLines`):
  - It re-reads the order to map each return line's `orderLineId` to a `variantId`. A missing order,
    or a line missing from it, is logged at `error` and skipped. That skip is not retried.
  - Every line is restocked at `INVENTORY_DEFAULT_STOCK_LOCATION`, whichever location the goods
    shipped from.
  - The single `inventory.stock.restock-from-return` call carries every remaining line. It goes
    through `retryThenLogForReplay` with three attempts and never fails the inspection
    ([`shared-libraries.md`](shared-libraries.md#retrythenlogforreplay)).
  - An inspection with no `restock` line makes no inventory call and no second order read.
- **`restockedLineCount` on `retail.return.inspected` counts the lines dispositioned `restock`**, not
  the lines sent or applied.

## Events and the buyer's email

`infrastructure/messaging/return-rabbitmq.publisher.ts`, `ReturnRabbitmqPublisher`. Each method
awaits the primary emit and then mirrors the event onto `ris.events`.

| Primary emit onto     | Events                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `notification_events` | `retail.return.requested`, `.authorized`, `.received`, `.inspected`: the notification returns consumer binds all four |
| `retail_queue`        | `retail.return.rejected`, `retail.return.closed`: no handler binds them                                               |

- **The two `retail_queue` events are received by retail and discarded**, each with an `error` log,
  as [`retail-orders.md`](retail-orders.md#what-retail_queue-does-with-an-event) describes. They survive
  only as their `ris.events` copy.
- **Every event is published after the commit, and a failure is only logged at `warn`.** A failed
  primary emit skips the mirror, so the event is lost from both.
- **The buyer's email is looked up once per event** (`application/use-cases/resolve-customer-email.ts`,
  `resolveCustomerEmail`):
  - It reads `SELECT email FROM customer WHERE id = ?`, with no status or `deleted_at` filter
    (`infrastructure/persistence/customer-contact-reader.typeorm.adapter.ts`). An erased customer has
    a `NULL` email.
  - A missing row, an empty `customerId` or a read error all give `customerEmail: null`. A read error
    is also logged at `warn`. The lookup never throws.
  - `customerLocale` is always `null`.

## Failure modes

| What breaks                                       | How it shows                                                                                               | What recovers it                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| One Open lists the same order line more than once | The RMA is opened for more units than the line has left                                                    | Staff rejects the RMA                                                     |
| Two Opens on one order run at the same time       | Both pass the quantity check against the same remainder, and both RMAs are opened                          | Staff rejects one                                                         |
| The restock fails after its three attempts        | An `error` log carrying `returnRequestId` and the lines. The RMA is `inspected`, and stock is not credited | An operator replays the RPC. Inventory is idempotent on `returnRequestId` |
| A restock line's order line cannot be resolved    | An `error` log for that line. The other lines are restocked, and `restockedLineCount` still counts it      | Manual: this skip is not in the replay record                             |
| An event publish fails after the commit           | A `warn` log. No event, and no `ris.events` copy                                                           | Nothing: there is no outbox                                               |
