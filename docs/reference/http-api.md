# HTTP request collections

This file covers the two request collections under `http/`: how they are wired, what they expect
from the running system, and what a run of them does today. What each route does, who may call it
and what it answers are in [`README.md` §6](../../README.md#6-http-api) and the gateway controllers.
How the Posting collection maps Kulala's chaining onto session variables is in
[`http/posting/README.md`](../../http/posting/README.md).

## Layout

- **One Kulala file per gateway area.** `http/kulala/` holds 17 `.http` files with 200 requests,
  each named by a `# @name` line. A later request reads an earlier response by that name.
- **Posting mirrors Kulala one to one.** `http/posting/` has one folder per Kulala file, one
  `*.posting.yaml` per request (200 in all) and a `scripts.py` per folder. The scripts copy values
  out of a response into session variables, because Posting has no response references.
- **The files hold no prose.** A request's route, guard and body shape come from its gateway
  controller and DTOs, which the interactive reference at `/api/reference` also renders.

## Environment

- **Kulala has one environment, `dev`.** `http/kulala/http-client.env.json` sets `ENV_BASE_URL` to
  `http://localhost:3000/api`, and every file starts with `@baseUrl = {{ENV_BASE_URL}}`. Posting reads
  the same value from `http/posting/dev.env`.
- **`/api` comes from `.env.example`, not from the code.** `API_GATEWAY_PREFIX` has no Joi default
  (`libs/config/config-module.config.ts`), and `.env.example` sets it to `api`
  ([`README.md` §8](../../README.md#8-configuration)). A different prefix, or none, needs a change in
  both environment files.

## Before a run

- **Start what [`README.md` §1](../../README.md#run-it) starts:** the infrastructure, both migration
  pipelines, the seed, then `yarn start:dev`. The `audit.http` requests are served by the event
  store. A gateway RPC has no timeout, so with no consumer on `event_store_query_queue` they hang
  instead of failing ([`api-gateway.md`](api-gateway.md#request-pipeline)).
- **The files expect a freshly seeded database.** They use the seeded logins
  ([`README.md` §1](../../README.md#seeded-logins)), product `1` with its variants `1` and `2`, the USD
  prices of variants `1`–`4` (`4999`, `4999`, `19999`, `19999`), their 100 units on hand at
  `default-warehouse`, and the seeded customer and admin ids, `00000000-0000-4000-a000-000000000002`
  and `…0001` (`scripts/test-db-seed.ts`, `scripts/seeds/`).

## How a file runs

- **Top to bottom.** Each file logs in first — as the seeded admin, the seeded customer, or both —
  and reads the login response for its bearer token. Later requests read ids out of earlier
  responses, either directly (`{{placeOrder.response.body.$.id}}`) or through a file variable
  declared in a `###` block of its own (`@accessToken = {{login.response.body.$.accessToken}}`).
- **Only `audit.http` depends on another file's writes.** `queryEventsByAggregate` asks for the
  events of order `1`, and the correlation id of its first row feeds `queryEventsByCorrelation` and
  `traceByCorrelation`. The seed writes nothing to `ris_eventstore`, so place an order first; any
  of `order.http`, `fulfillment.http`, `order-cancel.http`, `refunds.http` and `returns.http` does.
- **Two ids are placeholders.** `inventory.http` declares `@reservationId` as the all-zero UUID,
  which answers `404 INVENTORY_RESERVATION_NOT_FOUND`: no route returns a reservation id (where to
  find one is in [`README.md` §6](../../README.md#inventory)). `notifications.http` declares
  `@deliveryId = 1`; a delivery row exists only after a consumer has dispatched an event.
- **On a fresh seed, product `1` already has two media assets** (`scripts/seeds/media-asset.sql`).
  After `catalog-media.http` attaches three more, `listProductMedia` returns five, and
  `reorderReversed`, which sends only the three new ids, answers
  `409 CATALOG_MEDIA_REORDER_SET_MISMATCH`.
- **Six files cannot run twice against one database.** They create fixed slugs, SKUs, codes, role
  names and e-mails behind unique indexes. On a second run:

  | File                      | What fails                                                                                                           |
  | ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
  | `auth.http`               | `customerRegister` → `409`                                                                                           |
  | `iam.http`                | `createRole` and `createStaff` → `409`; `patchRole` → `404` on the missing id                                        |
  | `catalog.http`            | `registerProduct` → `409 CATALOG_PRODUCT_SLUG_TAKEN`; the requests that use its ids get none                         |
  | `catalog-categories.http` | the five creates → `409 CATALOG_CATEGORY_SLUG_TAKEN`                                                                 |
  | `catalog-media.http`      | `registerEasel` → `409 CATALOG_PRODUCT_SLUG_TAKEN`; the publish demonstration after it has no ids                    |
  | `pricing.http`            | `createTaxCategory` → `409 PRICING_TAX_CATEGORY_CODE_TAKEN`; both price sets → `409 PRICING_PRICE_SCHEDULE_CONFLICT` |

  The other eleven answer the same statuses again, on new ids. `yarn test:infra:reload` returns the
  database to the seed; it drops every local volume first.

## Failure modes

Kulala behaviour below is that of kulala.nvim at commit `dcad056` with `kulala-core` 0.37.0.

| What breaks                                                                                                     | How it shows                                                                                                                                                                                                                                                                          | What recovers it                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kulala-core` resolves `{{<name>.response…}}` only in a file that declares `# @kulala-vscode-restclient-compat` | No file declares it, so every response reference is empty: each protected request answers `401`, and `refresh` answers `400`                                                                                                                                                          | The declaration at the top of the file                                                                                                                               |
| A file variable declared inside a `###` block is visible to that block only                                     | `kulala-core` sends each variable-only block as a request with no URL, which fails; the requests that use the variable get an empty value                                                                                                                                             | Declaring the variable before the first `###`                                                                                                                        |
| `{{$guid}}` is not a `kulala-core` variable (`$uuid` and `$random.uuid` are)                                    | Place, capture, ship and issue refund send an empty `Idempotency-Key` and answer `400 IDEMPOTENCY_KEY_REQUIRED`                                                                                                                                                                       | `{{$uuid}}`                                                                                                                                                          |
| The replays send a new key                                                                                      | `@placeKey`, `@captureKey`, `@shipKey` and `@refundKey` are declared in the original request's block, so a `*Replay` or `*DifferentBody` request sends a different key: a second place is `201`, a second ship `409 FULFILLMENT_INVALID_STATUS_TRANSITION`, a second refund is issued | Running the flow from the Posting collection, whose `setup_*` scripts set a shared key only when it is absent (`http/posting/order/scripts.py`, `setup_place_order`) |
| A price set in the second half of a second is stored in the next one                                            | `publishEaselMediaLess` runs straight after `setEaselPrice` and can answer `409 CATALOG_PRODUCT_PUBLISH_REQUIRES_PRICE` ([`catalog-and-pricing.md`](catalog-and-pricing.md#prices))                                                                                                   | Sending the publish again a second later                                                                                                                             |
| `audit.http` runs before any order exists                                                                       | `queryEventsByAggregate` returns an empty page, so `queryEventsByCorrelation` sends `?correlationId=` and gets `400`, and `traceByCorrelation` requests `/audit/trace/` and gets `404`                                                                                                | Placing an order first                                                                                                                                               |
