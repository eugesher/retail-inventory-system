# Extension guide structure, and the check that keeps it honest

## 1. What `docs/extensions/` is for

[`docs/extensions/`](../../extensions/) holds one sketch per capability this system deliberately does
not have — product bundles, lot and expiry tracking, loyalty programs, a POS terminal — describing
**where each would attach** to the code that exists today.

It is there because "we don't do that" is a useless answer to a question that is really *"how hard
would it be?"* A reader evaluating this system for a business with perishable stock does not need
lot tracking to be built; they need to know that it attaches to `StockLevel`, that `variantId`
remains the backbone key, and which of the no-oversell invariants it complicates.

The folder is **forward-looking**. Nothing in it was rejected; these are capabilities a *universal*
retail core has no business carrying, because each belongs to a vertical rather than to retail as
such. Nothing there may read as a changelog or a scope negotiation.

## 2. Three places record something absent — one question routes a sentence to each

The repository keeps three records of things that do not exist, and they must not converge. The
argument is [ADR-055](../../adr/055-where-deliberately-unbuilt-work-is-recorded.md); the routing rule
is:

| Where | Admission question |
| --- | --- |
| [`README.md` § Not built yet](../../../README.md#14-not-built-yet) | *Does a named port, column, env var, cache-key builder or RPC already exist for it?* |
| [`docs/extensions/`](../../extensions/) | *Is it retail-relevant but not retail-**required*** — something a vertical needs and the core does not? |
| [`spec/transition-windows.spec.ts`](../../../spec/transition-windows.spec.ts) | *Is a future event supposed to make a specific person act by a specific date?* |

The third row is the one that needed deciding. [ADR-053](../../adr/053-how-a-transition-window-closes.md)
established that an obligation queued behind a condition must be registered, owned and dated — and
read naively, *"when someone builds bundles, delete `product-bundles.md`"* is exactly that. It is
not: **nobody owes any of it.** The condition may never fire, and if it does, the work that fires it
is standing in the guide's own subject matter. A guide has the standing ADR-053 gives a *reserved
surface* — an unused `CACHE_KEYS` builder — a registry entry where being complete is the point.

Getting this wrong would have cost something concrete: sixty-odd dated obligations in a register
ADR-053 keeps deliberately near-empty so that a red build there means something.

A ledger row and a guide **may** cover the same ground; six pairs do, including tax, multi-tenancy
and notifier transports. The row names the seam and links the guide; the guide describes the
capability and links back. Overlap is fine. **Restatement is not** — two files saying the same thing
in the same words is one file that gets updated and one that does not.

## 3. The template, and why these six sections

`Description` · `Business needs` · `Attachment points in the current core` · `Implementation sketch` ·
`Open design questions` · `Effort sketch`.

The order walks a reader from *what is this* to *would I want it* to *where does it touch my code* to
*what would I build* — and only then to what it costs. A guide that opens with effort has answered a
question nobody asked yet.

**`Open design questions` is mandatory, and it is the section that does the work.** A sketch with no
open questions has not been thought about; it has been *summarised*. The test of a real sketch is
whether it surfaces the decision that is actually hard — for exchanges, whether a replacement is a
new `Order` or a mutation of the old one; for bundles, whether the bundle or its components carry
stock. Writing that down is most of the value the folder has. A reader can re-derive a description
from any vendor's documentation; they cannot re-derive which invariant in *this* system the
capability strains.

## 4. Front matter, and why `attaches_to` is machine-checked

```yaml
---
title: Product bundles
cluster: Product Catalog
effort: 2–3 capabilities
attaches_to:
  - apps/catalog-microservice/src/modules/catalog/
  - apps/retail-microservice/src/modules/cart/
---
```

`title` matches the `# ` heading. `cluster` is one of nine names, verbatim. `effort` is one of three
values. `attaches_to` lists repository-relative paths that exist **today**.

The last one is checked, and naming the decay correctly is what made it possible. The failure mode is
**not** that someone builds the capability and forgets the guide — the person building it is reading
the guide. It is that *"attaches to the `Order` aggregate at `<path>`"* quietly stops being true when
a module moves eight months later, in a change that has nothing to do with extensions.

That condition is expressible as a test, and ADR-053 is explicit that a mechanical condition beats a
review date wherever one fits:

> *"Tie the window to the condition mechanically … This is strictly better where it is possible, and
> it should be preferred."*

So a dead anchor fails `yarn test:unit` on the commit that moves the module — when a human is
already looking at exactly that seam.

**The unit in `effort` is `capability`**, matching how [`docs/implementation/`](../) is organised.
It is a real unit here: a slice of work that produces a walkthrough note.

## 5. The five rails

A sketch that contradicts one of these is wrong, not creative. They are named once, in the folder's
own front matter contract, so that each guide does not rediscover them:

| Rail | Constraint | Source |
| --- | --- | --- |
| Events | dotted `<service>.<aggregate>.<action>` on the existing `ris.events` topic exchange — never a new transport or broker | [ADR-008](../../adr/008-rabbitmq-via-libs-messaging.md), [ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md), [ADR-035](../../adr/035-event-store-firehose-topic-exchange.md) |
| Shared types | cross-service types under `libs/contracts/<cluster>/`, never duplicated per service | [ADR-005](../../adr/005-split-shared-common-into-bounded-libs.md) |
| Cache | a cached read names a `CACHE_KEYS` builder with its version segment; no key literal in `apps/` | [ADR-016](../../adr/016-cache-aside-generalized.md), [ADR-022](../../adr/022-cache-keys-tenant-and-schema-version.md) |
| Layout | a new service is `apps/<name>/`; a new module is a per-module hexagon whose Nest module file is its composition root | [ADR-018](../../adr/018-nestjs-monorepo-apps-and-libs.md), [ADR-004](../../adr/004-adopt-hexagonal-architecture-per-service.md), [ADR-041](../../adr/041-nest-module-as-the-module-composition-root.md) |
| Privacy | no PII in an event payload or an audit row; tombstone-only erasure; consent default-transactional-on, default-marketing-off | [ADR-037](../../adr/037-consent-record-and-tombstone-erasure.md) |

A sixth rule is not a rail but governs all of them: **the source of truth is the code.** Every path,
port symbol, DI token, table, column, routing key and aggregate name a guide states is read out of
the source before it is written down — not from the root `README.md`, and not from these
implementation notes. A note like this one records a capability at the moment it shipped; it is good
evidence of *why* something was built as it was, and no evidence at all that it is still shaped that
way. `attaches_to` exists to make that non-optional for the half of the claim a machine can reach.

## 6. One guide owns a shared premise; the rest link to it

Eleven premises are presupposed by guides in different clusters — a `Supplier` party, a store-credit
ledger, a discount engine, a subscription plan, a B2B account, a tax call-out seam, a fraud-scoring
seam, an exchange model, customer segments, customer-side multi-factor auth, a transfer document.

Each is described **once**, in a named owning guide, and every other guide links to it. Without that
rule, four guides that each need a `Supplier` produce four incompatible sketches of one entity — and
a reader comparing them cannot tell whether the differences are meaningful or accidental. Worse, a
change to how suppliers would attach then has four homes and gets one.

The cluster order is arranged so that an owner is always written before its dependents, which means
**every cross-link points backward** and the link check is green at every step rather than only at
the end.

## 7. The index and the check

[`docs/extensions/README.md`](../../extensions/README.md) is the folder's front door: what it is, how
the three tiers differ, the lifecycle rule, the canonical template, and nine cluster tables.

[`spec/extension-guides.spec.ts`](../../../spec/extension-guides.spec.ts) runs under `yarn test:unit`
and asserts, over every guide:

- front matter parses and carries all four keys;
- `cluster` and `effort` are drawn from their literal lists — a typo in either silently removes the
  guide from its section while everything else still passes;
- **every `attaches_to` path exists on disk**;
- the six sections are present, in order, spelled exactly;
- `title` matches the `# ` heading;
- no relative link is dead;
- no reference to the orchestration scratch tree, no planning vocabulary.

And over the index: every guide is linked exactly once (no orphans, no duplicates), and no index link
points at a missing file. A guide not yet written is absent from both sides, so the bijection holds
while the folder fills up.

**What it cannot do, stated plainly:** it reaches the paths, never the prose. A guide whose sketch
describes an architecture three refactors old passes every assertion here. The check catches a moved
module, a mis-filed cluster, an orphaned file and a dead link — not a stale argument. Saying so
matters: a reader who believes the folder is machine-verified will trust it further than it earns.

## 8. Lifecycle: a guide is deleted when its capability is built

Not annotated as done, not kept as a record of what was once proposed. By then its content belongs in
a walkthrough under [`docs/implementation/`](../) written against real code, and `git` keeps the
history. The folder therefore only ever describes things that do not exist — which is the property
that makes it readable at a glance, and the one rule that stops it becoming an archive.
