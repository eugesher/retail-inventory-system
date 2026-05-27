---
epic: epic-00
task_number: 7
title: Extend ADR-008's References section + fold stale `MicroserviceClient{Retail,Inventory}Module` table narrative
depends_on: []
doc_deliverable: null
---

# Task 07 — Fold ADR-008 stale narrative (Notification client module + table scope)

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** Open ADR-008, ADR-011, and ADR-003 in full before deciding the wording. ADR-011 introduced the notification microservice and its `MicroserviceClientNotificationModule`. CLAUDE.md §"Shared Libraries" describes the live `libs/messaging` surface.

## ADR audited

[ADR-008 — RabbitMQ wiring via `libs/messaging` and dotted routing keys](../../../docs/adr/008-rabbitmq-via-libs-messaging.md). Accepted (2026-05-10).

## Discrepancy

ADR-008 §Decision table (line 37) enumerates the pre-wired Nest client modules as `MicroserviceClientRetailModule` and `MicroserviceClientInventoryModule`. The live `libs/messaging` now also exports `MicroserviceClientNotificationModule` (added by [ADR-011](../../../docs/adr/011-notifier-port-and-adapters.md)). This is **STALE-NARRATIVE**, not a code-discrepancy — the omission was true at time of writing and became stale when ADR-011 landed.

Per the user's audit guidance, this stale-narrative item is folded into a single ADR-008 amend task rather than getting its own correction task.

Surface: `docs/adr/008-rabbitmq-via-libs-messaging.md` (the ADR prose itself).

## Evidence

ADR-008 §Decision table row (`docs/adr/008-rabbitmq-via-libs-messaging.md:37`):

```text
| `MicroserviceClientRetailModule`, `MicroserviceClientInventoryModule` | Pre-wired Nest modules registering the retail/inventory clients under their `MicroserviceClientTokenEnum` tokens. |
```

Real layout (`libs/messaging/index.ts:1-9`):

```ts
export * from './exchanges.constants';
export * from './messaging.module';
export * from './microservice-client-inventory.module';
export * from './microservice-client-notification.module';
export * from './microservice-client-retail.module';
export * from './microservice-client.configuration';
export * from './rabbitmq.client.factory';
export * from './routing-keys.constants';
```

`libs/messaging/microservice-client-notification.module.ts` exists (verified by `ls libs/messaging/`).

ADR-011 (`docs/adr/011-notifier-port-and-adapters.md`) introduces the notification microservice and its messaging-client module.

## Why this matters

ADR-008 is foundational for every RabbitMQ wiring decision. A reader who lands on §Decision and counts the client modules will under-count by one, and may add a duplicate notification-client module instead of importing the existing one. The TASK-CONTRADICTIONs filed under epic-00/task-09 and epic-00/task-10 (which address the routing-key + publisher-port aspects of ADR-008) are the load-bearing fixes; this task closes the smaller narrative gap that surfaced during the same audit.

This is the same supersession-pointer pattern already filed for ADR-001 (epic-00/task-01), ADR-002 (epic-00/task-02), and ADR-004 (epic-00/task-04).

## Proposed resolution

Two options. Recommend **option A**.

**Option A — Amend ADR-008's Status line + add the missing forward link in `## References` (recommended).**

ADR-003 line 62 permits "flipping its `Status` and adding a one-line pointer." Use that allowance:

- Replace `**Status**: Accepted` with `**Status**: Accepted (client-module table extended by [ADR-011](011-notifier-port-and-adapters.md))`.
- Extend the existing `## References` section (`docs/adr/008-rabbitmq-via-libs-messaging.md:142-147`) with one extra bullet:
  - `[ADR-011](011-notifier-port-and-adapters.md)` — introduces `MicroserviceClientNotificationModule`, the third pre-wired client module that joins the two listed in §Decision.

Do **not** rewrite the table on line 37. The Nygard immutability rule (ADR-003) keeps the original table as the historical record; the forward link redirects the reader to ADR-011 for the complete current set.

**Option B — Rewrite the table row in place to add `MicroserviceClientNotificationModule`.**

Mechanically simpler for future readers but violates ADR-003's immutability promise. Sets a precedent for in-place rewrites that erodes trust in the ADR set.

## Scope

**In:**

- Edit `docs/adr/008-rabbitmq-via-libs-messaging.md` Status line + extend `## References` section (option A).

**Out:**

- Any change to `libs/messaging/` modules — the live state is correct.
- Any change to ADR-011 (already describes the notification client module).
- Any change to the offending decomposed task contradictions filed separately in `epic-00/task-09` (legacy enum) and `epic-00/task-10` (ClientProxy in use case).

## Exit criteria

- [ ] A reader landing on ADR-008 sees a forward link to ADR-011 in the References section, signalling that the client-module table is not the complete current set.
- [ ] No other ADR's text was edited beyond what the resolution requires.
- [ ] `yarn lint` still passes (touching only `docs/adr/*.md` should be a no-op for lint).
- [ ] `tmp/adr-verification-progress.md` ADR-008 row is updated to `HAS-CORRECTIONS` with a pointer back to this task.
