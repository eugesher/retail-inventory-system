# task-10 — Write application-layer articles (Phase: application-layer/) — DRAFT

> **DRAFT — may be revised by task-01.**

## Context

- Migration source of truth: `parts/recommendation.md`
  Sections 3 and 4 (the use-case-vs-service distinction, the DTO
  suffix convention), ADR-004 (the application/ layer's role),
  ADR-011 (the `NotifierPort` template),
  `docs/architecture-migration-plan/tasks/task-07-build-notification-service.md`.
- Previous carryover:
  `docs/architecture-migration-ru/tasks/_carryover-09.md`
  (READ FIRST).
- Guide root: `docs/architecture-migration-ru/architecture-migration-guide.md`.
- Conventions preamble: see `task-01-survey-and-scaffold.md`.
- Where the guide stands: every infrastructure-side concern
  (persistence, messaging, caching, auth, observability) is
  written. The reader knows where the adapters live and how the
  libraries cooperate. This task covers the **application layer
  itself** — how use cases differ from fat services, how DTOs are
  named per direction, and how outbound delivery is abstracted via
  a port.

## Prerequisites

- [ ] `_carryover-09.md` exists and was read first.
- [ ] Build is green on entry.
- [ ] HEAD SHA is recorded in `_carryover-01.md`.

## Goal

Write the three application-layer articles. After this group, a
mid-level reader should be able to add a new use case to one of the
microservices and pick the right DTO suffix without checking the
recommendation document.

## Article slots to fill

- [ ] `docs/architecture-migration-ru/application-layer/use-cases-vs-fat-services.md`
- [ ] `docs/architecture-migration-ru/application-layer/dto-by-direction.md`
- [ ] `docs/architecture-migration-ru/application-layer/notifier-port-and-adapters.md`

> Approximate guidance:
>
> - **use-cases-vs-fat-services** — ~2000 words. Anchor to
>   `recommendation.md` § "Patterns to avoid" and ADR-004. The
>   "fat service" anti-pattern (one class injects
>   `Repository<X>` + `ClientProxy` + cache + logger and does
>   everything). The use-case alternative — one class per write,
>   thin, depends only on ports. Show migration before/after:
>   `OrderConfirmService` → `ConfirmOrderUseCase`,
>   `ProductStockOrderConfirmService` →
>   `ReserveStockForOrderUseCase`.
> - **dto-by-direction** — ~1500 words. The five DTO suffix
>   convention from `recommendation.md` Section 4:
>   `*.request.dto.ts`, `*.response.dto.ts`, `*.command.ts`,
>   `*.query.ts`, `*.view.ts`. Why direction-tagged suffixes —
>   anti-pattern of one shared DTO for HTTP body + RPC payload +
>   persistence + event. Concrete examples from
>   `libs/contracts/retail/` and `libs/contracts/inventory/`.
> - **notifier-port-and-adapters** — ~1800 words. Anchor to
>   ADR-011. The `INotifierPort` interface + `NOTIFIER` symbol;
>   `LogNotifierAdapter` as the default binding;
>   `EmailNotifierAdapter` / `WebhookNotifierAdapter` as scaffolds.
>   Why this is the canonical per-module template — and how the
>   inventory `stock` module and the retail `orders` module mirror
>   the same shape.

## Steps

1. **Read previous carryover.**
2. **Read the source ADRs.** ADR-004, ADR-011 (full), ADR-012 §1–4,
   ADR-013 §1–4.
3. **Author each article.** Code anchors (verify in task-01):
   - **use-cases-vs-fat-services**:
     `apps/retail-microservice/src/modules/orders/application/use-cases/confirm-order.use-case.ts`,
     `apps/inventory-microservice/src/modules/stock/application/use-cases/reserve-stock-for-order.use-case.ts`,
     the three ports that
     `ConfirmOrderUseCase` injects (`ORDER_REPOSITORY`,
     `ORDER_EVENTS_PUBLISHER`, `INVENTORY_CONFIRM_GATEWAY`).
   - **dto-by-direction**: `libs/contracts/retail/`
     subtree (order DTOs), `libs/contracts/inventory/`
     subtree (stock DTOs), the
     `IRetailOrderCreatedEvent` and
     `IInventoryStockLowEvent` event payload types.
   - **notifier-port-and-adapters**:
     `apps/notification-microservice/src/modules/notifications/application/ports/notifier.port.ts`
     (`INotifierPort` + `NOTIFIER`),
     `apps/notification-microservice/src/modules/notifications/infrastructure/delivery/log.notifier.adapter.ts`,
     `apps/notification-microservice/src/modules/notifications/application/use-cases/send-order-notification.use-case.ts`,
     `send-low-stock-alert.use-case.ts`,
     `apps/notification-microservice/src/modules/notifications/infrastructure/consumers/order-events.consumer.ts`,
     `inventory-events.consumer.ts`,
     `apps/notification-microservice/src/modules/notifications/infrastructure/notifications.module.ts`.
4. **Cross-link** to `[[hexagonal-architecture]]`,
   `[[clean-architecture-layers]]`,
   `[[mappers-and-repositories]]`,
   `[[message-vs-event-patterns]]`,
   `[[routing-keys-and-contracts]]`,
   `[[shared-libs-philosophy]]`.

## Verification

- [ ] Three articles filled, no `заглушка` callouts.
- [ ] Permalinks pinned to the recorded SHA.
- [ ] Every wiki link resolves.
- [ ] No orphans.

## Carryover

Write `_carryover-10.md` per the standard structure.
