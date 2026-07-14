// **Every event in this folder is built by the USE CASE, after its transaction has committed.**
// None is drained from a model: `StockLevel`, `Reservation` and `StockLocation` are plain classes,
// not `AggregateRoot`s, so there is no `pullDomainEvents()` to pull from (ADR-012 §6 — the one
// decision ADR-027 kept when it replaced the rest of that ADR).
//
// The consequence is the part worth carrying: **an event here is evidence that the write already
// happened.** It cannot veto the write, a failed publish cannot roll it back, and a consumer that
// never receives one has learned nothing about whether the stock moved. Every emit is best-effort
// and post-commit.
//
// `aggregateId` is the `variantId` throughout — the key everything downstream of catalog rides on
// (ADR-027 §4).
export * from './stock-adjusted.event';
export * from './stock-level-initialized.event';
export * from './stock-low.event';
export * from './stock-received.event';
export * from './stock-reserved.event';
export * from './stock-released.event';
export * from './stock-allocated.event';
export * from './stock-committed.event';
export * from './stock-returned.event';
