# Reference — current behaviour the code does not say out loud

This folder is the living reference for facts about the system **as it runs today** that a
competent engineer reading the code would miss or misread: invariants, ordering constraints
(what happens before the commit and what after it), why a race is safe, failure modes, units and
time zones, and the contracts one service silently relies on from another. When such a fact would
otherwise need a sentence next to the code, it belongs here instead.

The code is the truth. Every entry is checked against it before it is written, and every entry
names the place it describes, so a reader can check it again.

## What belongs where

| Kind of knowledge                                                     | Home                                                                                          |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| How something behaves now, when the code alone does not make it plain | **this folder**                                                                               |
| Why it was decided that way, and what was rejected                    | [`docs/adr/`](../adr/) — an entry here links the ADR and does not restate it                  |
| How a capability was delivered, step by step                          | [`docs/implementation/`](../implementation/)                                                  |
| What a review found at a point in time                                | [`docs/audits/`](../audits/)                                                                  |
| A capability the system deliberately does not have                    | [`docs/extensions/`](../extensions/)                                                          |
| HTTP routes, configuration, seed data, background jobs                | [`README.md`](../../README.md) — §6, §8, §10, §13                                             |
| Which error code maps to which HTTP status                            | the module's `*RpcExceptionFilter`                                                            |
| What the code already says through names, types and test titles       | nowhere — a paraphrase of the code is not an entry                                            |
| How the code got to where it is                                       | `git log` and the history-bearing folders above — this folder describes only what is true now |

## How an entry is written

- **One short claim in the present tense**, followed by its anchor: the path and the symbol, never
  a line number (line numbers drift):

  > A requested sweep batch size that is not a finite number — including `null` — falls back to
  > the configured ceiling; a number is truncated and clamped to `[1, ceiling]`
  > (`apps/inventory-microservice/src/modules/stock/application/use-cases/sweep-expired-reservations.use-case.ts`,
  > `SweepExpiredReservationsUseCase.resolveLimit`).

- **Verified before it is written.** Read the code down to where the behaviour actually happens;
  where a test pins the behaviour, name the test too. A statement that cannot be checked against
  the code is not written.
- **Rationale is a link.** If an ADR explains why, link it and stop there: the entry above would
  point at [ADR-038](../adr/038-reservation-ttl-sweep-and-bounded-batches.md) for why the batch
  size is a ceiling, not explain it again.
- **Kept current in the same change.** A pull request that changes behaviour described here
  updates the entry, or deletes it when the behaviour is gone.

## Files

One file per area. A file is created when its area has something to say; there are no empty
placeholders.

| File                                  | Area                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `wire-contracts.md`                   | `libs/contracts` — payloads, views, enums, units                        |
| `shared-libraries.md`                 | the other `libs/*`                                                      |
| `retail-orders.md`                    | retail `modules/orders/`                                                |
| `retail-cart.md`, `retail-returns.md` | retail `modules/cart/`, `modules/returns/`                              |
| `inventory.md`                        | inventory `modules/stock/`                                              |
| `catalog-and-pricing.md`              | catalog `modules/catalog/`, `modules/pricing/`                          |
| `notifications.md`                    | notification `modules/notifications/`                                   |
| `event-store.md`                      | event store `modules/audit-and-events/`                                 |
| `api-gateway.md`                      | `apps/api-gateway`                                                      |
| `testing.md`                          | the e2e harness under `test/` and the repository self-checks in `spec/` |
| `architecture-lint.md`                | the rules in `eslint.config.mjs`                                        |
| `persistence.md`                      | schema facts from `migrations/` and the seeds under `scripts/`          |
| `build-and-ci.md`                     | Dockerfile, CI workflow, compose files, `.env.example`                  |
| `http-api.md`                         | the request collections under `http/`                                   |

## Shape of an area file

1. An H1 naming the area.
2. One paragraph: what the file covers, and which ADRs carry the rationale for it.
3. A section per aggregate, component or use case, holding short anchored claims.
4. A **Failure modes** subsection wherever the area has any: what breaks, how it shows, and
   what recovers it.
