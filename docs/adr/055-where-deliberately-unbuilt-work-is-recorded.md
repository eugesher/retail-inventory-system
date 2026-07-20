# ADR-055: Where deliberately-unbuilt work is recorded — three ledgers, one question each

- **Date**: 2026-07-20
- **Status**: Accepted

---

## Context

This repository now keeps **three** written records of things that do not exist:

- [`README.md` § Not built yet](../../README.md#14-not-built-yet) — sixteen rows, each a gap in the
  core whose seam is already in the code.
- [`spec/transition-windows.spec.ts`](../../spec/transition-windows.spec.ts) — the register
  [ADR-053](053-how-a-transition-window-closes.md) created, holding obligations somebody owes,
  each with an owner and a `reviewBy` date CI enforces.
- [`docs/extensions/`](../extensions/) — sixty-four sketches of capabilities the system deliberately
  does not have, each describing how it would attach if a business ever needed it.

Three ledgers of absence, and no rule saying which one gets a given sentence. Left undecided they
converge: the same fact lands in two of them, with two different decay rates, and the one nobody
rereads goes stale first. That is the failure [ADR-046](046-libs-layout-and-dead-export-removal.md)
and ADR-053 have already been paid for twice.

### The specific misclassification this decision prevents

ADR-053 hands every reader a live classification test, and it is one a reader **will** apply to
`docs/extensions/`:

> *"An obligation queued behind a condition must be registered, owned, and DATED … The distinction is
> one question: is a future event supposed to make somebody act?"*

Read naively, *"when someone builds product bundles, delete `product-bundles.md`"* is an obligation
queued behind a condition — and `docs/extensions/` is sixty-four of them. Registering sixty-four
dated windows would turn a register ADR-053 deliberately keeps near-empty into precisely what it
forbids it to become:

> *"It is a place to put the next one, **not a backlog to admire**."*

The correct reading is the other one ADR-053 offers: a *reserved surface* — an unused `CACHE_KEYS`
builder, an unused `EXCHANGES` member — is **one line in a registry where being complete is the
point**, and nobody owes anything. An extension sketch is that, not a window. This ADR exists because
that reading has to be written down once, or it gets re-litigated sixty-four times.

## Decision

> **Three tiers. One admission question each.**
>
> | Tier | Holds | Admission test |
> | --- | --- | --- |
> | `README.md` **§ Not built yet** | a gap in the core, with the seam already in the code | *Does a named port, column, env var, cache-key builder or RPC already exist for it?* |
> | `docs/extensions/` | a capability deliberately outside the universal core | *Is it retail-relevant but not retail-**required** — something a vertical needs and the core does not?* |
> | `spec/transition-windows.spec.ts` | an obligation somebody owes, queued behind a condition | *Is a future event supposed to make a specific person act by a specific date?* |
>
> **`docs/extensions/` is a registry, not a set of transition windows.** Nobody owes anything: the
> condition may never fire, and if it does, the work that fires it is standing in the guide's own
> subject matter. A guide gets no `reviewBy` and no entry in the register — the same standing an
> unused `CACHE_KEYS` builder has under ADR-053.

### A row and a guide may cover the same ground; neither may restate the other

The ledger row names the seam and links the guide. The guide describes the capability and links the
row. Six such pairs exist today — tax, multi-tenancy, notifier transports, ESP webhook ingestion, the
payment processor, and locale resolution — and in each the two halves answer different questions:
*"what in the code is already shaped for this?"* versus *"what would the capability be?"*

**Restatement is the thing to refuse**, not overlap. Two files describing the same seam in the same
words is one file that will be updated and one that will not.

### All sixteen current ledger rows pass the ledger's own test

This was verified against the code rather than assumed, because a classification rule that quietly
evicts sixteen rows on the day it lands is a rule that was written to justify a deletion. Each of the
sixteen names something that exists — `clampPageWindow`, `RETENTION_DELIVERY_DAYS`, `PAYMENT_GATEWAY`
with its `FakePaymentGatewayAdapter`, the `notification.delivery.record-outcome` routing key, the
`NOTIFIER` port and its `LogNotifierAdapter` default, `customerLocale`, `TaxCategory`,
`StaffUser`'s `status` and its unreachable suspend, `MediaAsset.uri`, the reserved `catalogCategory*`
builders, the `t:<tenantId>` key segment. **Nothing moves out of the ledger.** The tiers are a rule
for what arrives next, not a reorganisation.

### The mechanism: a test, because ADR-053 says to prefer one

ADR-053 rejects a mechanical condition as the *general* rule while stating plainly that it is better
wherever it fits:

> *"Tie the window to the condition mechanically … **This is strictly better where it is possible,
> and it should be preferred.**"*

For an extension sketch it fits, once you name the realistic decay correctly. The failure mode is
**not** that someone builds the capability and forgets to delete the guide — the person building it
is reading that guide. It is that a guide's *"attaches to the `Order` aggregate at `<path>`"* quietly
stops being true when a module moves, months later, in a change that has nothing to do with
extensions.

That condition **is** expressible as a test. Every guide declares its attachment points in front
matter, and [`spec/extension-guides.spec.ts`](../../spec/extension-guides.spec.ts) asserts those paths
exist on disk. A guide pointing into thin air fails `yarn test:unit` on the commit that moves the
module — the moment a human is already looking at exactly that seam.

The check reaches the paths, never the prose. It cannot know whether a sketch's *reasoning* is still
sound, and this ADR would rather ship a check that is true than one that appears comprehensive.

### Lifecycle: a guide is deleted when its capability is built

When a capability actually lands, its guide is **removed**, not annotated as done and not kept as a
record of what was once proposed. The content it carried is by then a
[`docs/implementation/`](../implementation/) walkthrough, written against real code. The folder
therefore only ever describes things that do not exist, which is the property that makes it readable
at a glance.

This rule lives here and in [`docs/extensions/README.md`](../extensions/README.md), and nowhere else.

## Consequences

### Positive

- **A sentence about something absent has exactly one home**, decided by one question, and the three
  questions do not overlap.
- **`spec/transition-windows.spec.ts` stays small enough to be read.** Its value is that a red build
  names a real obligation; sixty-four entries nobody owes would have destroyed exactly that.
- **The guides carry the one check their realistic decay admits.** A module rename now breaks a
  guide loudly rather than silently.
- **The forward-looking framing is enforced by the lifecycle rule.** A folder that deletes on
  completion cannot accumulate into a record of rejected proposals.

### Negative

- **The tier boundary is a judgement, not a computation.** "Retail-relevant but not retail-required"
  admits argument at the margin — lot and expiry tracking is core to a grocer and exotic to a
  bookshop. The rule narrows the argument; it does not end it.
- **Nothing detects a guide whose *content* has decayed.** The path check passes while the sketch
  above it describes an architecture three refactors old. This is the same gap ADR-053 records as
  open, in a different shape, and naming it is the honest thing: a reader who believes the folder is
  fully machine-verified will trust it further than it earns.
- **Deletion-on-completion loses the sketch's history.** Deliberate — `git` keeps it, and a live file
  describing a built capability is worse than no file.

## Alternatives considered

- **Register each guide as a transition window.** Rejected — sixty-four dated obligations nobody
  owes, in a register ADR-053 keeps deliberately near-empty precisely so a red build means something.
  It would also force sixty-four arbitrary review dates whose only honest outcome each time is to
  move the date, which ADR-053 already names as the ritual that turns the mechanism into theatre.
- **Fold the guides into `README.md` § Not built yet.** Rejected — the ledger's rows each name a seam
  that exists in code, and that is what makes the section a list of *near-term* gaps a reader can act
  on. A bundle extension names no seam, and an eighty-row table no longer reads as anything.
- **Write nothing down and rely on the folder name being self-evident.** Rejected — this is exactly
  what ADR-046 did with its deferred-deletion rule, and ADR-053 exists because it did not work.
  Knowing costs nothing and forgetting costs nothing unless the rule is written where the next reader
  lands.

## References

- [ADR-053](053-how-a-transition-window-closes.md) — the register this decision keeps guides *out*
  of, and the source of both the "is a future event supposed to make somebody act?" test and the
  "prefer a mechanical condition where it fits" preference this ADR acts on.
- [ADR-046](046-libs-layout-and-dead-export-removal.md) — the reserved-surface idea a guide inherits
  its standing from, and the precedent for why an unwritten rule is an unheld rule.
- [ADR-003](003-record-architecture-decisions.md) — numbering, slug and immutability rules.
- [`docs/extensions/README.md`](../extensions/README.md) — the folder's front door: the template, the
  front matter contract, and the same lifecycle rule stated for the reader who arrives there first.
