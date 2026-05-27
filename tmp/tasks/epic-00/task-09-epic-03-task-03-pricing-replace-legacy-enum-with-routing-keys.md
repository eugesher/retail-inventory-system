---
epic: epic-00
task_number: 9
title: Rewrite `epic-03/task-03` to register `CATALOG_PRICE_*` keys in `ROUTING_KEYS`, not the legacy `MicroserviceMessagePatternEnum`
depends_on: []
doc_deliverable: null
---

# Task 09 — Fix `epic-03/task-03` legacy-enum usage (ADR-008 new-callers rule)

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** Open ADR-008 and ADR-009 in full before editing. ADR-008 §Decision table establishes `MicroserviceMessagePatternEnum` as the **back-compat** surface and `ROUTING_KEYS` as the idiomatic constants object **for new callers**. ADR-009 §"Routing keys" tightens this into a "fresh-write rule" for the gateway. CLAUDE.md §"Message patterns" treats `ROUTING_KEYS` as the canonical wire-format registry.

## ADR audited

[ADR-008 — RabbitMQ wiring via `libs/messaging` and dotted routing keys](../../../docs/adr/008-rabbitmq-via-libs-messaging.md). Accepted (2026-05-10).

## Contradiction

`tmp/tasks/epic-03-pricing-price-and-tax-category/task-03-pricing-use-cases-set-schedule-select.md:159` registers a new `@MessagePattern` against `MicroserviceMessagePatternEnum.CATALOG_PRICE_SET`. Two problems:

1. **Wrong surface for new keys** — ADR-008 §Decision table is explicit: "`ROUTING_KEYS` — Frozen `as const` object… **Idiomatic constants object for new callers**; `MicroserviceMessagePatternEnum` remains for backwards compatibility." A brand-new `catalog.*` routing key has no back-compat consumer; the entire `catalog.*` family is being introduced by epic-02/epic-03. New keys must land in `ROUTING_KEYS`.
2. **The cited enum value does not exist** — `MicroserviceMessagePatternEnum` (in `libs/contracts/microservices/microservice-message-pattern.enum.ts:4`) contains only the retail / inventory / notification routing keys (the original five from pre-task-04 plus the events added later). There is no `CATALOG_PRICE_SET` in the enum. A literal read of the task would require the implementer to either invent the enum value (extending the back-compat surface that ADR-008 says should not gain new entries) or have the code fail to compile.

Surface: `tmp/tasks/epic-03-pricing-price-and-tax-category/task-03-pricing-use-cases-set-schedule-select.md`.

## Evidence

ADR-008 §Decision table (`docs/adr/008-rabbitmq-via-libs-messaging.md:40`):

```text
| `ROUTING_KEYS` | Frozen `as const` object mirroring `MicroserviceMessagePatternEnum`. Idiomatic constants object for new callers; `MicroserviceMessagePatternEnum` remains for backwards compatibility. |
```

ADR-008 §Decision §"Wire-format routing keys" (`docs/adr/008-rabbitmq-via-libs-messaging.md:86-89`):

```text
`MicroserviceMessagePatternEnum` keeps its identifier names and
flips its values; `ROUTING_KEYS` exposes the same strings. Callers
that imported the enum continue to compile; only the wire format
changed.
```

(The "callers that imported the enum continue to compile" framing only covers **existing** callers — adding new identifiers to the enum is outside the scope of "back-compat".)

Offending task line (`tmp/tasks/epic-03-pricing-price-and-tax-category/task-03-pricing-use-cases-set-schedule-select.md:155-162`):

```ts
  ) {}

  @MessagePattern(MicroserviceMessagePatternEnum.CATALOG_PRICE_SET)
  setPriceHandler(@Payload() input: SetPriceDto) { return this.setPrice.execute(input); }

  // … one handler per pattern …
}
```

`MicroserviceMessagePatternEnum` current shape (`libs/contracts/microservices/microservice-message-pattern.enum.ts:4-16`):

```ts
export enum MicroserviceMessagePatternEnum {
  INVENTORY_PRODUCT_STOCK_GET = 'inventory.product-stock.get',
  INVENTORY_ORDER_CONFIRM = 'inventory.order.confirm',
  INVENTORY_STOCK_LOW = 'inventory.stock.low',
  RETAIL_ORDER_CREATE = 'retail.order.create',
  RETAIL_ORDER_CONFIRM = 'retail.order.confirm',
  RETAIL_ORDER_GET = 'retail.order.get',
  RETAIL_ORDER_CREATED = 'retail.order.created',
  RETAIL_ORDER_CONFIRMED = 'retail.order.confirmed',
  RETAIL_ORDER_CANCELLED = 'retail.order.cancelled',
  NOTIFICATION_HEALTH_PING = 'notification.health.ping',
}
```

`CATALOG_PRICE_SET` is not present. The neighbouring tasks in epic-03 (task-01:137-138, task-03:30) treat `ROUTING_KEYS.CATALOG_PRICE_CHANGED` and `ROUTING_KEYS.CATALOG_PRICE_SCHEDULED` as the canonical surface for the new `catalog.price.*` family — only the `CATALOG_PRICE_SET` registration on task-03:159 picks the legacy enum. Internal inconsistency within the same epic.

## Why this matters

Every other decomposed task in epic-02, epic-03, and epic-04 honours the ADR-008 new-callers rule (`ROUTING_KEYS.CATALOG_PRODUCT_REGISTER`, `ROUTING_KEYS.CATALOG_VARIANT_CREATED`, `ROUTING_KEYS.INVENTORY_STOCK_RECEIVE`, etc.). Letting one task slip onto the legacy enum:

- Sets a confusing precedent for future implementers (which surface do I use? both seem allowed?).
- Bloats `MicroserviceMessagePatternEnum` with entries it was never meant to carry, making the eventual deprecation of the legacy enum harder.
- Misleads the reader of task-03 about the implemented convention.

## Proposed resolution

Recommend **option A**.

**Option A — Rewrite `task-03:159` to use `ROUTING_KEYS.CATALOG_PRICE_SET` (recommended).**

`tmp/tasks/epic-03-pricing-price-and-tax-category/task-03-pricing-use-cases-set-schedule-select.md` is edited in one place:

- Line 159: rewrite the code example from
  ```ts
  @MessagePattern(MicroserviceMessagePatternEnum.CATALOG_PRICE_SET)
  ```
  to
  ```ts
  @MessagePattern(ROUTING_KEYS.CATALOG_PRICE_SET)
  ```

  The matching key constant `CATALOG_PRICE_SET: 'catalog.price.set'` is registered in `libs/messaging/routing-keys.constants.ts` (task-03's existing acceptance text already mentions `CATALOG_PRICE_CHANGED` and `CATALOG_PRICE_SCHEDULED` registrations on line 30 — verify whether `CATALOG_PRICE_SET` belongs in the same registration block; if missing, add a one-line note in this correction task instructing task-03 to register it).

Also sweep `task-03` (and any neighbouring epic-03 task that mirrors the pattern) for the `MicroserviceMessagePatternEnum` import statement near line 159 and replace with `ROUTING_KEYS` from `@retail-inventory-system/messaging`.

**Option B — Add `CATALOG_PRICE_SET` to the legacy enum and amend ADR-008 to permit new entries.**

Rejected. Would require a fresh ADR superseding ADR-008's "new callers reach for `ROUTING_KEYS`" decision and is disproportionate to a one-line task fix.

## Scope

**In:**

- Edit `tmp/tasks/epic-03-pricing-price-and-tax-category/task-03-pricing-use-cases-set-schedule-select.md` at line 159 (option A).
- Sweep for the matching import statement in the same task body if present.

**Out:**

- Any change to `libs/messaging/routing-keys.constants.ts` itself (task-03's acceptance criteria already register the relevant `CATALOG_PRICE_*` constants; this correction task only fixes the wording of how the handler binds them).
- Any change to `libs/contracts/microservices/microservice-message-pattern.enum.ts`.
- Any change to ADR-008 itself (the binding rule is correct; the task contradicts the rule).

## Exit criteria

- [ ] `tmp/tasks/epic-03-pricing-price-and-tax-category/task-03-pricing-use-cases-set-schedule-select.md` no longer references `MicroserviceMessagePatternEnum`; the `@MessagePattern` binding uses `ROUTING_KEYS.CATALOG_PRICE_SET`.
- [ ] No other task file under `tmp/tasks/**` was edited.
- [ ] `yarn lint` still passes (this task edits only `tmp/tasks/**/*.md`).
- [ ] `tmp/adr-verification-progress.md` ADR-008 row is updated to `HAS-CORRECTIONS` with a pointer back to this task.
