---
title: Replacement orders as a distinct entity
cluster: Order Management
effort: 1 capability
attaches_to:
  - apps/retail-microservice/src/modules/orders/domain/order.model.ts
  - apps/retail-microservice/src/modules/returns/domain/return-request.model.ts
---

# Replacement orders as a distinct entity

## Description

When a shop ships a replacement — a warranty swap, a damaged-in-transit reship, a wrong-item
correction — the right model is **a new `Order`**, linked to the original, not a mutation of the original
and not a bespoke entity. A replacement has to ship: it needs lines, a fulfilment, stock allocation and a
delivery. All of that already hangs off `Order`, so anything other than a new order re-implements
shipping badly.

This guide **owns the replacement-as-a-new-`Order` argument** — the decision two later returns-cluster
guides build on. Exchanges-as-a-first-class-entity and advance-replacement both inherit "a replacement is
a new `Order` linked to the original"; this guide makes that concrete so they compose it rather than
re-litigate it.

## Business needs

- **Warranty and defect replacements** — the customer keeps or returns the faulty unit and receives a
  fresh one at no charge; the shop needs to ship and track that second unit.
- **Damaged-in-transit reships** — the original never arrived usable, so a replacement goes out while the
  claim is handled separately.
- **Wrong-item corrections** — the shop shipped the wrong SKU and owes the right one; the correction is a
  shipment, so it is an order.
- The threshold: a shop that only ever refunds (never re-ships) does not need this; the first "we'll send
  you a new one" is where a replacement has to become a shippable record.

## Attachment points in the current core

- **The `Order` aggregate at
  `apps/retail-microservice/src/modules/orders/domain/order.model.ts`.** A replacement reuses the entire
  immutable order machinery — `OrderLine` snapshots, the `Fulfillment` sibling, the three orthogonal
  status axes, stock allocation, the delivery terminal. The only thing it needs that a normal order does
  not is a **link back to what it replaces** and a **zero-value money path** (the goods are already paid
  for, or written off).
- **The `ReturnRequest` aggregate at
  `apps/retail-microservice/src/modules/returns/domain/return-request.model.ts`** — a replacement is
  frequently *triggered by* an RMA. `ReturnRequest` already keys to the original order (`orderId`) and its
  lines to `orderLineId`, so a replacement spawned from a return can carry that provenance. Note `Refund`
  and `ReturnRequest` are **distinct** (a return may close with a replacement instead of a refund) — the
  same independence a replacement relies on.

## Implementation sketch

- **A replacement is an ordinary `Order`** with two additions: a `replacesOrderId` reference (and,
  optionally, an `originatingReturnId`) linking it to what it replaces, and a **zero-value line path** —
  lines at `unitPriceMinor` 0, or a full-order discount, so `grandTotalMinor` is 0 and no capture is
  attempted. The place flow, fulfilment, allocation and delivery are otherwise unchanged.
- **The original order is never mutated** — it is immutable, and the replacement stands beside it. The
  link is a new column on the order, not an edit to the original; provenance flows forward, never
  backward.
- **No new payment** — a zero-value replacement authorizes nothing (the place flow skips authorize when
  the grand total is 0, the digital-good precedent), so `Payment` is untouched. A *paid* upgrade
  replacement (customer pays the difference) is the exception and rides the normal payment path.
- **Stock is really allocated** — a replacement ships real units, so it decrements a real `StockLevel`
  and writes a real commit-sale movement, exactly as a paid order does. The replacement is free to the
  customer, not free to inventory.
- **Events** ride `ris.events` — `retail.order.placed` for the replacement (carrying the `replacesOrderId`
  so downstream can see the linkage), plus an optional `retail.replacement.created`. No new transport.
- **Shared types** (the replacement command carrying the link) under `libs/contracts/<cluster>/`.

## Open design questions

- **What zero-values the order** — lines priced at 0, or a 100% order-level discount? The first keeps the
  line snapshot honest-but-free; the second keeps the original price visible with a discount total. This
  is the concrete modelling choice the two dependent guides inherit.
- **Return-first or replace-first?** If the replacement ships before the faulty unit comes back (advance
  replacement), the shop is exposed until the return arrives — that is a distinct guide, but the *link
  model* here has to support "replacement exists before the return closes."
- **Partial replacements** — one line of a multi-line order is replaced; the replacement order carries a
  subset of the original's lines, which the `replacesOrderId` link alone does not disambiguate without
  line-level provenance.
- **Inventory source** — is a replacement always fulfilled from own stock, or can it dropship, and does a
  warranty replacement draw from a separate returns/refurbished pool?

## Effort sketch

`1 capability` — a `replacesOrderId` link, a zero-value line path, and the place-skips-authorize branch,
all on top of the existing order subsystem. It is small **because** it reuses `Order`, `Fulfillment` and
allocation wholesale; the argument it settles — replacement *is* a new order — is what makes the later
exchange and advance-replacement guides cheap too.
