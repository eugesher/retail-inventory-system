# Posting collection

A [Posting](https://posting.sh) port of the Kulala HTTP library in
[`../kulala`](../kulala). Same endpoints, same top-to-bottom exercise flows —
expressed in Posting's collection format (one `*.posting.yaml` per request,
subcollection folders per original `.http` file).

## Run

```bash
posting --collection http/posting --env http/posting/dev.env
```

Launch at the collection **root** (`http/posting`) — script paths in the
request files (e.g. `auth/scripts.py:capture_staffLogin`) resolve relative to
it. `dev.env` mirrors the Kulala `dev` environment (`ENV_BASE_URL`).

Prereqs are the same as the Kulala library — bring the stack up, migrate, seed,
and start the gateway:

```bash
docker compose up -d
yarn migration:run
yarn test:seed
yarn start:dev
```

## How this maps from Kulala

Kulala chains requests **declaratively** — a later block interpolates an
earlier response inline: `{{staffLogin.response.body.$.accessToken}}`. Posting
has no such reference. Instead:

| Kulala | Posting |
| --- | --- |
| `{{ENV_BASE_URL}}` / `@baseUrl` | `$ENV_BASE_URL` from `dev.env` (`--env`) |
| `# @name foo` block | `foo.posting.yaml` (the `name:` field) |
| block comment | the request's `description:` field |
| `{{login.response.body.$.accessToken}}` | an `on_response` script on the producer calls `posting.set_variable("accessToken", …)`; consumers read `$accessToken` |
| `{{$guid}}` | a `setup` script sets a fresh UUID variable (used in later subcollections that need idempotency keys) |

The capture scripts live in a `scripts.py` beside each subcollection's requests
(e.g. [`auth/scripts.py`](auth/scripts.py)) and are wired via the request's
`scripts.on_response` field.

### Run requests in order

Because Posting substitutes variables with a **strict** `string.Template`, a
request that reads `$accessToken` before its producer has run fails loudly with
a `SubstitutionError` (not a silent empty value). Run each subcollection
top-to-bottom: the login/producer requests first, then the consumers — exactly
the ordering the Kulala files document.

### Idempotency keys (shared vs fresh)

The Kulala `{{$guid}}` maps to a `setup` script. Two shapes exist:

- **Shared key** (e.g. `$placeKey`, `$captureKey`) — set **once, if absent**, so
  the original request and its `*Replay` / `*DifferentBody` siblings send the
  **same** `Idempotency-Key` (that is what makes a replay a replay). To start a
  fresh cycle, clear the session variable (Posting command palette → *Clear
  variable*, or `posting.clear_variable(...)` in a script) and re-run the
  original.
- **Fresh key** (e.g. `$place_order_again_guid`) — regenerated on **every** send,
  mirroring a bare `{{$guid}}` (the store-miss demonstrations).

## Subcollections

All 17 Kulala files are ported (200 requests). Each folder mirrors the
same-named `../kulala/<name>.http` and carries its own `scripts.py`.

| Folder | Requests | Folder | Requests |
| --- | ---: | --- | ---: |
| `audit/` | 11 | `iam/` | 8 |
| `auth/` | 8 | `inventory/` | 15 |
| `cart/` | 10 | `notifications/` | 13 |
| `catalog/` | 12 | `order/` | 12 |
| `catalog-categories/` | 18 | `order-cancel/` | 13 |
| `catalog-media/` | 17 | `pricing/` | 8 |
| `consent/` | 5 | `refunds/` | 16 |
| `customer-admin/` | 5 | `returns/` | 16 |
| `fulfillment/` | 13 | | |

> Note: `notifications/author-template` authors a Handlebars notification
> template whose body contains `{{orderId}}` / `{{grandTotalMinor}}`. Those are
> **template** placeholders (resolved server-side at render time), not Posting
> variables — they are sent verbatim, exactly as in the Kulala original.

> Note: `audit/query-events-by-aggregate` captures `$tracedCorrelationId` out of
> its **first result row** (`items[0].correlationId`), which
> `audit/query-events-by-correlation` and `audit/trace-by-correlation` consume.
> Its hook sets nothing when the page is empty, so those two then fail with a
> `SubstitutionError` rather than querying a fabricated id — place an order first.
