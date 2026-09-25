# Notifications

This file covers what the notification module
(`apps/notification-microservice/src/modules/notifications/`) does today that its names and types do
not say. It covers the render-and-dispatch pipeline, the delivery row and its retries, the template
registry, the consent gate, the consumers, what the service's queue does with a message, and the
retention purge. Paths below are relative to that folder unless they start at the repository root.
The rationale lives in the ADRs:

- [ADR-011](../adr/011-notifier-port-and-adapters.md): the one-method `NOTIFIER` port and inline
  `correlationId` logging (§7).
- [ADR-033](../adr/033-notification-templates-deliveries-and-render-dispatch.md): templates,
  deliveries, persist-then-send, retry and the dedupe column.
- [ADR-037](../adr/037-consent-record-and-tombstone-erasure.md): consent, the
  `skipped-no-consent` status, and erasure.

The statuses, the consent table, the retry backoff and the consumers are in
[`README.md` §4](../../README.md#notifications-notification-microservice). The two timers are in
[§13](../../README.md#13-background-jobs), and the configuration keys in
[§8](../../README.md#8-configuration). The code-to-status table is
`presentation/notification-rpc-exception.filter.ts`.

## `RenderAndDispatchUseCase`

Every dispatch consumer and the marketing send go through
`application/use-cases/render-and-dispatch.use-case.ts`. It is the only code that creates a
delivery row.

- **The steps run in this order:**
  1. Resolve the template.
  2. Render the subject and body.
  3. If the input has a `recipientCustomerId`, run the dedupe pre-check, then the consent gate.
  4. Persist a `queued` row.
  5. Call `NOTIFIER.send`.
  6. Save the row as `sent` or `failed`.

  If no active template exists, the render throws, or the rendered body is blank after trimming,
  the use case logs at `warn` and returns `null`. No row is written in those cases.

- **The dedupe pre-check and the consent gate depend on `recipientCustomerId`, not on who the email
  is for.** Five routing keys pass `null`: `inventory.stock.low` (the ops alert), and four
  customer-facing ones — `retail.order.cancelled`, `retail.fulfillment.shipped`, `.delivered` and
  `retail.refund.issued`. Their contracts carry `customerEmail` but no `customerId`. Rows for those
  four emails are never deduped, and the gate never reads the buyer's consent. A customer who turned
  `transactionalEmail` off still receives them. Their entries in
  `application/use-cases/transactional-event-types.ts` are never consulted (see
  [Consumers](#consumers)).
- **The dedupe scope includes the template id.** The generated `delivery_dedupe_key` joins
  `template_id`, `event_reference_type`, `event_reference_id`, `channel` and
  `recipient_customer_id` (`migrations/1781992928341-CreateNotificationTables.ts` at the repository
  root). `NotificationDeliveryTypeormRepository.findByDedupeKey` matches the same five columns.
  When a new template version is authored for the event type, the same event is no longer a
  duplicate, and it is sent again.
- **The pre-check returns a row in any status, and dispatches nothing.** That includes a `queued` or
  `failed` row. Such a row is left to the [retry paths](#retries).
- **The race backstop works only after the winner has changed its status.** Two dispatches of one
  event can both pass the pre-check. The loser's insert then hits the UNIQUE index, and
  `NotificationDeliveryTypeormRepository.save` re-reads the winner's row by the five columns and
  returns it. The use case skips the send only if that row is no longer `queued`. If the winner is
  still between its insert and its final save, the loser sends as well, then saves over the
  winner's row. For a row with a null `recipientCustomerId`, a duplicate-key error is rethrown:
  it cannot be the dedupe race, because a null key never collides.
- **Every dispatch uses the locale `en-US`.** No consumer passes a locale, so
  `IRenderAndDispatchInput.locale` always falls back to `DEFAULT_LOCALE`. A `customerLocale` on the
  event would change nothing.
- **A channel with no subject gets a fallback subject at send time, but the fallback differs between
  the first send and a retry.** The first send uses the event type (`retail.order.placed`); a retry
  uses the row's `eventReferenceType` (`order`). The row's `renderedSubject` stays `null`
  (`application/use-cases/transport-subject.ts`). Today every dispatch is `email`, so neither
  fallback runs.
- **A `NOTIFIER` failure is recorded on the row and never rethrown.** Anything else that throws is
  not caught: a template read, the pre-check, or either save. It escapes the consumer. What the
  queue then does is in [What the queue does with a message](#what-the-queue-does-with-a-message).

## `NotificationDelivery`

- **No row ever reaches `delivered` or `bounced`.** Only `RecordDeliveryOutcomeUseCase` sets them,
  through `notification.delivery.record-outcome`. That RPC has no gateway route, and nothing inside
  the system publishes it. `LogNotifierAdapter` reports no outcome. Treat both statuses as empty
  when you read the table.
- **The row has no version column.** Two writers of one row are last-writer-wins. A manual retry and
  the sweeper can both send the same row, and so can the sweepers of two replicas.
- **An erasure does not touch this table.** The gateway erase writer
  (`apps/api-gateway/src/modules/auth/infrastructure/persistence/customer-erasure-writer.adapter.ts`)
  changes `customer`, `address`, `cart` and `consent_record`. An erased customer's
  `recipient_address` and rendered bodies stay here until the [purge](#retention-purge) removes
  them. A retry sends to that stored address.

## Retries

`RetryDeliveryUseCase.reattempt` is the only other `NOTIFIER.send` call. Both the manual RPC
(`notification.delivery.retry`) and the sweeper (`RetryFailedDeliveriesUseCase`) go through it.

- **A retry re-sends the row as it was stored.** It uses the stored address, subject and body. It
  does not look up the template, and it does not ask the consent gate again. A customer who
  withdrew consent after the first attempt still receives the retry.
- **Two kinds of row are retryable** (`application/use-cases/queued-staleness.ts`):
  - a `failed` row;
  - a `queued` row whose `created_at` is more than `QUEUED_STALE_AFTER_MS` (5 minutes) in the past.
    This is an _orphan_: the process died between the insert and the final save, or that save
    threw. A redelivered event does not rescue it, because the pre-check returns the `queued` row
    without sending. A `queued` row younger than 5 minutes may still be dispatching: the manual
    retry refuses it with `409`, and the sweeper does not select it.

  `sent`, `delivered`, `bounced` and `skipped-no-consent` rows are refused with `409`.

- **Rescuing an orphan can send a second copy.** The first send may have succeeded, with only the
  status write lost. Nothing can tell the two cases apart.
- **The sweeper's scan** (`NotificationDeliveryTypeormRepository.listRetryable`) ORs two arms:
  - `failed` rows with `attempt_count < MAX_DELIVERY_ATTEMPTS`;
  - `queued` rows older than the 5-minute horizon.

  It takes at most 50 rows (`SWEEP_BATCH_SIZE`), ordered by `last_attempt_at` ascending, then by
  `id`. MySQL sorts `NULL` first, so orphans lead the batch. A row is due when
  `lastAttemptAt + 1000 ms · 2^(attemptCount − 1) ≤ now`. An orphan has no `lastAttemptAt`, so
  it is due at once. The base (`RETRY_BACKOFF_BASE_MS`), the batch size and the 5-minute horizon
  are constants, not configuration.

- **One failing row does not stop the sweep.** Each row is retried inside its own `try`, and is
  logged under the row's own `correlationId`. The sweep logs its summary under a fresh one.
- **A rescued orphan that fails again becomes an ordinary `failed` row with `attemptCount = 1`.**
  From there it gets the full retry budget.
- **`notifications.delivery.failed` is emitted each time an attempt leaves the row `failed` with
  `attemptCount ≥ MAX_DELIVERY_ATTEMPTS`.** The sweeper stops selecting the row after that, so a
  scheduled retry emits the event once. The manual retry still accepts a capped `failed` row, and
  every failed manual attempt emits the event again. The event carries
  `failureReason ?? 'unknown'`. A publish failure is logged at `warn`, and the retry still
  succeeds.
- **The failure event goes to the service's own queue and is dropped there.** It is emitted onto
  `notification_events`, which has no handler for it. The queue does not auto-acknowledge (see
  below), so `ServerRMQ.handleEvent` nacks it without requeue (`@nestjs/microservices` 11.1.19).
  Only the `ris.events` copy survives.

## Templates and rendering

- **An author always writes a new, active row.** The version is `MAX(version) + 1` over every row
  for the key, active or not (`NotificationTemplateTypeormRepository.maxVersion`). A duplicate-key
  error on insert becomes `409 TEMPLATE_DUPLICATE_VERSION`, whether the driver error arrives flat or
  nested under `driverError` (`NotificationTemplateTypeormRepository.save`). Authoring never
  deactivates the older versions.
- **The live template is the highest active version** (`findLatestActive`). Activating an older
  version while a newer one is active changes nothing. To roll back, deactivate every version above
  the one you want.
- **No migration seeds a template.** They come only from `scripts/seeds/notification-template.sql`
  ([`README.md` §10](../../README.md#10-seed-data)). Until an operator authors templates or runs the
  seed, every dispatch logs "No active notification template found" and writes nothing. The
  marketing send returns `null`.
- **`HandlebarsTemplateRendererAdapter` caches one compiled function per distinct source string.**
  The cache is a process-local `Map` with no eviction. Every template version ever rendered keeps
  its entry until the process restarts.

## Consent gate

- **`DEFAULT_CONSENT` is what an absent row means** (`application/ports/consent-reader.port.ts`).
  Transactional email is on, and both marketing channels are off. Its `dataRetentionPolicy`,
  `default-7-years`, is a separate literal from the gateway's `DEFAULT_DATA_RETENTION_POLICY`. The
  gate never reads that field.
- **`ConsentCache.get` never throws.** On a hit it returns the cached snapshot. On a miss it
  single-flights the reader and writes the result back for `NOTIFICATIONS_CONSENT_CACHE_TTL_SECONDS`
  (converted to milliseconds). If the cache path throws, it calls the reader directly. If the reader
  throws, it returns `DEFAULT_CONSENT` (`infrastructure/cache/consent.cache.ts`).
- **`set` and `del` only log a failure.** If the eviction on `customer.erased` fails, the old
  snapshot is served until the TTL runs out.
- **A cache miss can overwrite a fresher write-through.** Suppose a dispatch reads `consent_record`
  just before a consent change commits, and writes its result after the `customer.consent.updated`
  write-through. The cache then holds the old snapshot until the TTL expires (300 s by default).
- **After an erasure the reader finds no row.** The gateway erase deletes the `consent_record` row,
  so the next load resolves to `DEFAULT_CONSENT`.

## Consumers

| Routing key                                               | Reference                                     | `recipientCustomerId` | Deduped, consent-gated |
| --------------------------------------------------------- | --------------------------------------------- | --------------------- | ---------------------- |
| `retail.order.placed`                                     | `order` / `orderId`                           | the event's           | yes                    |
| `retail.return.{requested,authorized,received,inspected}` | `return-request` / `rmaId`                    | the event's           | yes                    |
| `retail.order.cancelled`                                  | `order` / `orderId`                           | `null`                | no                     |
| `retail.fulfillment.shipped` / `.delivered`               | `fulfillment` / `fulfillmentId`               | `null`                | no                     |
| `retail.refund.issued`                                    | `refund` / `refundId`                         | `null`                | no                     |
| `inventory.stock.low`                                     | `stock-low` / `<variantId>:<stockLocationId>` | `null`                | no                     |
| `notification.marketing.send` (RPC)                       | `marketing` / `campaignId`                    | the payload's         | yes                    |

A customer-facing event whose `customerEmail` is null or blank is logged at `warn` and skipped
before the pipeline runs (`infrastructure/consumers/dispatch-customer-email.ts`). The
`inventory.stock.low` alert goes to `OPS_NOTIFICATIONS_EMAIL`. `ConsentEventsConsumer` sends
nothing: it catches every error from the cache. The six dispatch consumers catch nothing.

### What the queue does with a message

- **Nothing ever acknowledges a message on `notification_events`.** The notification `main.ts` sets
  `noAck: false`. No handler takes the `RmqContext` channel, and `ServerRMQ` in
  `@nestjs/microservices` 11.1.19 acks nothing on its own: `handleMessage` and `handleEvent` only
  `nack` a message that has no handler. Every event and every RPC the service handles stays
  unacknowledged for as long as its channel lives.
- **So every handled message is delivered again, over and over.** The broker requeues all unacked
  messages whenever the channel closes:
  - when the service stops or restarts;
  - when a delivery has been unacknowledged longer than RabbitMQ's `consumer_timeout`. The broker
    then closes the channel with `406 PRECONDITION_FAILED`, and Nest reconnects and receives
    everything again. The default is 30 minutes in the pinned `rabbitmq:4.2.3` image, and
    `docker-compose.yml` does not change it.

  The requeued copy is again never acknowledged, so the cycle repeats as long as the service runs.

- **What a replay does, per message:**
  - `retail.order.placed` and the four `retail.return.*` events: the pre-check finds the row and
    logs "Duplicate delivery". After a new template version for that event type, the email is sent
    again.
  - The four customer-facing events with a null `recipientCustomerId`, and `inventory.stock.low`: a
    new row and a new email on every replay.
  - `customer.consent.updated`: writes that event's snapshot into the cache again.
  - `notification.template.author`: authors another version with the same content, which becomes
    the live one. That undoes a rollback made after the original author.
  - `notification.delivery.retry`: retries again. A row that is now `sent` answers `409`; one that
    is still `failed` gets another attempt.
  - `notification.marketing.send`: collapses on the dedupe key (same `campaignId` and customer),
    unless the template changed in between.
  - `.template.set-active`: sets the same flag again. `.delivery.record-outcome`: `409`, since the
    row is no longer `sent`. The reads: nothing. Each reply goes to a caller that has stopped
    waiting.
- **A handler that throws does not trigger a redelivery.** Nest's `RpcExceptionsHandler` logs the
  error, and the message stays unacknowledged like any other. It comes back only on the next channel
  close.

## Retention purge

The mechanism and the dedupe trade-off are in [`README.md` §13](../../README.md#13-background-jobs)
and the `RETENTION_DELIVERY_DAYS` row of §8.

- **The purge removes at most 500 rows a day.** `DeliveryRetentionScheduler.sweep` runs once, at
  03:00 (`CronExpression.EVERY_DAY_AT_3AM`), and calls `PurgeAgedDeliveriesUseCase.execute` once.
  That issues one `DELETE … WHERE created_at < ? LIMIT 500`
  (`NotificationDeliveryTypeormRepository.deleteOlderThan`). A backlog is not drained within the
  night. If more than 500 deliveries are written per day, the table keeps growing. The info log's
  `batchFull: true` shows when the limit was hit.
- **03:00 is in the Node process's local time zone.** The `@Cron` passes no `timeZone`.
- **The horizon is `now − RETENTION_DELIVERY_DAYS` on the Node clock, compared with `created_at`.**
  The comparison is strict, and it ignores status: a `queued` or `failed` row is purged like any
  other.

## Configuration

- **`NOTIFIER_TEST_FLAKY` switches the notifier only for the exact string `true`.** The `NOTIFIER`
  factory in `notifications.module.ts` reads `process.env` when DI initialises, not
  `ConfigService`, so an e2e suite that sets it in `beforeAll` is seen. Joi also accepts `TRUE` or
  `True` as a boolean, and either one leaves `LogNotifierAdapter` bound.
- **`FlakyLogNotifierAdapter` fails a body containing `__FAIL_ONCE__` once per
  `recipient|subject|body` signature.** A retry re-sends the same stored content, so it succeeds.
  The set of failed signatures lives in memory, so a restart fails the marked content once more.

## Failure modes

| What breaks                                                               | How it shows                                                                                                     | What recovers it                                                              |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| The service restarts, or a delivery stays unacked past `consumer_timeout` | Every message handled so far is replayed: duplicate emails for undeduped events, re-run RPCs                     | Nothing in the code                                                           |
| A template is re-authored                                                 | The next replay of a deduped event for that event type sends a second email                                      | Nothing                                                                       |
| The process dies between the `queued` insert and the final save           | An orphaned `queued` row                                                                                         | The sweeper after 5 minutes, or a manual retry. Either may send a second copy |
| A template read, the pre-check or a save throws inside a dispatch         | `RpcExceptionsHandler` logs an error. No row, or an orphaned `queued` row                                        | The next replay of the message, or the retry paths for an orphan              |
| A customer turned transactional email off                                 | Cancellation, shipping, delivery and refund emails still go out: the gate never runs for them                    | Nothing                                                                       |
| A customer withdraws consent or is erased after a failed attempt          | The retry still sends the stored content to the stored address                                                   | Nothing                                                                       |
| Two dispatches of one deduped event run concurrently                      | Both send if the loser re-reads the winner's row while it is still `queued`                                      | Nothing                                                                       |
| The eviction on `customer.erased` fails                                   | The cached snapshot is served until the TTL expires                                                              | The TTL                                                                       |
| More than 500 deliveries are written per day                              | The purge falls behind, and `notification_delivery` keeps growing                                                | Nothing in the code; `batchFull: true` in the purge's info log shows it       |
| No template is seeded                                                     | Each dispatch logs "No active notification template found" and writes nothing; the marketing send returns `null` | Run `yarn test:seed`, or author the templates                                 |
