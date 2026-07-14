# ADR-053: How a transition window closes — a rule with no check is a wish

- **Date**: 2026-07-13
- **Status**: Accepted

---

## Context

[ADR-046](046-libs-layout-and-dead-export-removal.md) already wrote this rule down, in as many words:

> *"A deletion queued behind a condition, with no owner and no check, is not queued — it is
> **forgotten**."*

**And then it was forgotten.** Three times, in three different shapes, and the third one was still
running on the hot path of every stock write eleven epics later.

| Queued behind | What happened to the condition | Discharged |
| --- | --- | --- |
| `CacheHelper` — *"behind the next cache-key version bump"* (ADR-006 §Open) | the key went **`v1 → v2 → v3`**. It fired **three times** | ADR-046, eleven epics late |
| `POST /auth/login` — *"a deprecated alias kept for one release"* | it was written **in the commit that introduced the route**. There was no previous release | ADR-050, eleven epics late |
| Four Redis `SCAN` passes — *"for the rolling deploy that adopts v3"* | **no deploy ever straddled a version.** The window defended a transition that never happened | ISSUE-03, `79b111a` |

**Three obligations. Three conditions met or void. Zero acted on.**

Not one of them was hidden. Each was written down, in a comment, honestly, by someone who meant to
come back. `CacheHelper`'s note named its condition precisely. The alias named its expiry. The SCAN
comments even named their cost.

### What actually failed, and it was not diligence

**The condition was never anyone's job to notice.** A cache-key bump is a one-line edit in
`cache-keys.ts`; nothing about making it asks *"does this discharge an obligation?"*. A release
happens; nothing about releasing asks *"did anything promise to die this release?"*. The condition
fires in a place that has no connection to the code waiting on it.

So the promise is checked exactly when someone happens to reread the comment that contains it — which
is to say, **never**, because a comment that reads plausibly is a comment nobody rereads. All three of
these were found by an audit that was looking at something else.

**A deferred deletion has the same failure mode as a stale comment: it is believed, so it is not
checked.** This repository has spent an entire pass learning that lesson about comments
(ADR-049, ADR-050, ISSUE-10 — each replaced an assertion with something that *fails*). The deferred
obligation is the same defect wearing a schedule.

### The trap this ADR must not fall into

**An ADR that restates the rule is the fourth instance of the rule being ignored.** ADR-046 restated
it and was ignored. The problem was never that nobody knew; it is that knowing costs nothing and
forgetting costs nothing.

**So the rule ships with its enforcement or it does not ship.**

## Decision

> **An obligation queued behind a condition must be registered, owned, and DATED — and the date must
> be enforced by a test that goes red.**
>
> If you cannot name an owner, a closing condition and a review date, **you have not deferred the
> work. You have hidden it.** Do the work now, or do not create the debt.

### The mechanism: `spec/transition-windows.spec.ts`

A register, and a check. It is deliberately small — what was missing for eleven epics was never a
clever design, it was **a date and something that reads it**.

```ts
interface ITransitionWindow {
  id: string;         // a stable handle, so a red build names the thing
  what: string;       // the obligation. What is owed.
  condition: string;  // what discharges it
  owner: string;      // a ticket or a person. "The team" is not an owner.
  reviewBy: string;   // ISO date — the day CI forces the conversation
  adr: string;        // the decision it came out of
}
```

Three tests:

1. **No open window is past its `reviewBy`.** This is the whole mechanism. The failure message carries
   the *entire entry* — what is owed, what closes it, who owns it — because a red build that says
   `expected 1 to be 0` teaches the next person to delete the test.
2. Every window names an owner, a condition, an ADR and a **well-formed** date. *(A typo in the date
   silently becomes `Invalid Date`, which compares `false` against everything — it would disarm test 1
   **without failing anything**. That is the exact class of silent-green this ADR exists to stop, so it
   is pinned.)*
3. **No window defers its review by more than two years.** A date a decade out is the same forgetting,
   wearing a date.

### `reviewBy` is a deadline for the DECISION, not for the work

CI does not know whether your condition has fired, and it must not pretend to. What it can guarantee
is that **on a chosen day, a human looks.** The three outcomes are all legitimate:

- discharge it;
- **move the date, deliberately, and say why in the commit** — a promise renewed on purpose is not a
  promise forgotten;
- decide the obligation was never real and delete the entry, with the reasoning.

**Deleting the entry to make CI green is the failure this ADR exists to stop**, and the failure
message says so.

### What does NOT go in the register

**A reserved surface is not a transition window.** An unused `CACHE_KEYS` builder, an unused
`EXCHANGES` member, a `PermissionCodeEnum` value nothing gates yet — these are *one line in a registry
where being complete is the point* (ADR-046), and **nobody owes anything**. Nothing is waiting on a
condition; nothing is supposed to happen.

The distinction is one question: **is a future event supposed to make somebody act?** If yes, it is a
window and it needs a date. If no, it is a registry entry and it needs nothing.

### The register starts with one entry, and that is the healthy state

| id | owed | closes on | review by |
| --- | --- | --- | --- |
| `capture-claim-reconciler` (ADR-052) | `ReportStaleCaptureClaimsUseCase` **reports** stranded `capturing` payments and resolves none — it cannot, because `IPaymentGatewayPort` has no *"did my capture land?"* query | a real payment gateway is bound; every real processor exposes a capture-status query | **2027-01-13** |

It is nearly empty **because the three obligations that taught us to build it have just been paid
off.** It is a place to put the next one, not a backlog to admire.

## Consequences

### Positive

- **A deferred obligation now has a due date that CI reads.** The three that were forgotten each had a
  condition nobody was positioned to notice; a date is noticed by definition.
- **The failure is actionable.** It names the obligation, its closing condition and its owner — the
  next person does not have to reconstruct the intent from a comment written a year ago.
- **The cost of creating debt is now visible at the moment of creating it.** Registering a window means
  writing down an owner and a date, out loud, in a file other people read. That is a small friction,
  and it is aimed exactly where the three failures happened: at the moment someone thought *"I'll come
  back to this."*

### Negative

- **The date is a proxy.** CI cannot check *"has the rolling deploy completed?"* — it checks *"has the
  day arrived?"*. A window can come due before its condition fires, and the honest answer then is to
  move the date. That is a ritual, and rituals decay: **if every review is a rubber-stamped date bump,
  this becomes theatre.** The commit message is the only thing standing between the two, which is why
  the failure message demands one.
- **It is a register a human maintains.** Nothing forces a new obligation to be *entered*. A developer
  who writes *"delete this after X"* in a comment and registers nothing is exactly where we were —
  and no lint rule can read intent out of prose.

### Open

- **Nothing detects an unregistered window.** The one real gap. A grep for `TODO` / `for now` /
  `deprecated` / `remove after` in comments could surface candidates and is a plausible next step, but
  it is a heuristic over prose, not a guarantee — and this ADR would rather ship a check that is true
  than a check that is comprehensive.

## Alternatives considered

- **Restate the rule in prose and rely on review.** Rejected — **this is what ADR-046 did**, and it is
  why this ADR exists. The rule was known. Knowing was not the problem.
- **A lint rule over comments** (ban `TODO:` without a date). Rejected as the *primary* mechanism: it
  polices the *phrasing* of an intention rather than the intention, is trivially evaded by rewording,
  and would have caught **none of the three** — every one of them was written as calm, complete,
  well-argued prose, not as a `TODO`.
- **Tie the window to the condition mechanically** — e.g. a test that fails when
  `INVENTORY_STOCK_KEY_VERSION` advances past the version a legacy sweep defends. **This is strictly
  better where it is possible, and it should be preferred**: it fires on the *real* event rather than a
  date. It is rejected as the general rule only because most conditions are not expressible that way
  (*"a real gateway is bound"*, *"one release"*), and a mechanism that only covers the easy cases would
  have missed two of our three. **Where you can write the condition as a test, do — and set the date
  anyway, as the backstop.**
- **Just don't defer anything.** Attractive, and unrealistic. Some obligations genuinely cannot be
  discharged today — the capture reconciler cannot be built against a gateway that has no
  capture-status API. The point is not to forbid debt; it is to stop debt from being **silent**.

## References

- [ADR-046](046-libs-layout-and-dead-export-removal.md) — where this rule was first stated, and first
  ignored. `CacheHelper`: *"a deletion queued behind a condition, with no owner and no check, is not
  queued — it is forgotten."*
- [ADR-050](050-the-alias-that-was-born-deprecated.md) — the alias that was deprecated in the commit
  that created it, and lived eleven epics.
- [ADR-052](052-claim-before-you-charge.md) — the source of the register's first and only entry.
- ADR-049 / ADR-050 / ISSUE-10 — the same move, three times: **replace an assertion that is believed
  with something that fails.** This ADR applies it to a promise.
