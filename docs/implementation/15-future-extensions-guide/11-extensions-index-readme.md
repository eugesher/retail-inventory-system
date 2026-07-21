# The extensions index, and the checks that keep it in step

[`docs/extensions/README.md`](../../extensions/README.md) is the front door to sixty-four capability
sketches. This note covers the finished index: what it holds, the four mechanical checks that keep it
honest against the folder beside it, and — the part that matters most — what those checks cannot
reach.

[`01-extension-guide-structure-and-template.md`](01-extension-guide-structure-and-template.md)
established the template and the routing rule between the three records of absent things; this note
does not restate either. It picks up where that one left off: the folder is now whole, and the
completeness checks that were deliberately withheld while it filled up have landed.

## 1. What the index holds

Five things, in this order:

- **What the folder is for**, and the sentence that keeps it readable: it is forward-looking, not a
  record of rejected features.
- **The three-tier comparison** — the root [`README.md` § Not built yet](../../../README.md#14-not-built-yet)
  ledger, this folder, and [`spec/transition-windows.spec.ts`](../../../spec/transition-windows.spec.ts)
  — with one admission question routing a sentence to each
  ([ADR-055](../../adr/055-where-deliberately-unbuilt-work-is-recorded.md)).
- **The lifecycle rule**: a guide is deleted when its capability is built, never annotated as done.
- **The canonical template** — front matter, six sections, the five rails a sketch must honour, and
  the instruction that every path and symbol be read out of source rather than out of a document.
- **Nine cluster tables**, one row per guide: a link and a one-line hook.

The first four were written once and are unchanged; the tables filled in cluster by cluster.

## 2. The nine clusters, and their sizes

| Cluster | Guides |
| --- | --- |
| Product Catalog | 9 |
| Inventory | 8 |
| Order Management | 10 |
| Customer & Identity | 7 |
| Returns & Refunds | 6 |
| Pricing & Promotions | 8 |
| Notifications & Events | 8 |
| Staff & Access Control | 7 |
| Physical Retail | 1 |

Physical Retail's single guide is not an omission — the seven pieces of that surface arrive as one
decision, and [`10-physical-retail-extension-guide.md`](10-physical-retail-extension-guide.md) is the
argument for keeping them in one file.

**These numbers are asserted, not stated.** They appear here because
[`spec/extension-guides.spec.ts`](../../../spec/extension-guides.spec.ts) holds them; if this table
and that file ever disagree, the file is right and the build is already red.

## 3. How the index stays in step with the folder

Four assertions, each catching a different way the two can drift apart. The first two existed from
the start; the last two landed once the folder was complete.

| Check | What it catches | What it misses on its own |
| --- | --- | --- |
| **Bijection** — every guide linked exactly once, no duplicates | An orphan guide: a file written and never listed. | Nothing, at a known size — but at an *unknown* size it is silent about a guide that was never written at all. |
| **No dead index link** | A row pointing at a file that was renamed or deleted. | A guide that exists but has no row. |
| **Total count** | A guide added or deleted without the index being touched. | Which one, and in which cluster. |
| **Per-cluster counts** | A guide filed under the wrong cluster. | A guide whose cluster is right and whose content is wrong. |

The per-cluster check is the one that earns its keep, because the failure it catches is otherwise
completely silent. A guide with `cluster: Physical Retail` in a customer-identity file has valid front
matter, six correct sections, live `attaches_to` paths, a resolving title and an index row — **every
other assertion in the file passes.** It is simply missing from the section a reader would look in,
and present in one where it makes no sense. Nothing else notices.

That gap was real until this change: the existing `cluster` assertion checks the value is one of the
nine literal names, which catches a *misspelled* cluster and not a *misfiled* one. The two counts
together close it.

## 4. Each assertion was seen red before it was trusted

A count assertion that has never failed is a count nobody has verified — it may be comparing a
constant to itself. All three were observed failing, in three separate perturbations chosen so that
each one fails in isolation:

| Perturbation | What went red |
| --- | --- |
| One guide file moved out of the folder | *"holds 63 guides, expected 64"* and *"cluster 'Customer & Identity' holds 6 guides, expected 7"*. The index-link count stayed **green** — correctly: the index still listed sixty-four, the folder had shrunk. |
| One index row unlinked, guide untouched | *"README.md links 63 distinct guides, expected 64"*, alongside the pre-existing orphan check. The total stayed green — the folder was intact. |
| One guide's `cluster` changed to a different valid name | *Only* the per-cluster check, naming both sides: the cluster that lost a guide and the one that gained it. The total and the index-link count both stayed green, which is exactly the blind spot this assertion exists to cover. |

Each message names the discrepancy and what to do about it. That is deliberate: a red build reading
`expected true to be false` teaches the next reader to delete the test.

## 5. What the checks cannot do

They reach the paths; they never reach the prose.

A guide whose sketch describes an architecture three refactors old passes every assertion in the
file. `attaches_to` is machine-checked because a *path* has a mechanical truth condition — the file
either exists or it does not — and the realistic decay is a module moving in a change that has
nothing to do with extensions, which the build then catches on the commit that moves it. A sketch's
*argument* has no such condition. Nothing here can tell that a guide still recommends binding against
a port that was replaced, or that its trade-off analysis rests on a constraint that was lifted.

Naming that limit is the honest thing, and it is the reason it is stated in the index, in the spec's
own header comment, and again here. A reader who believes the folder is machine-verified will trust
it further than it earns. What the checks guarantee is that the folder is **well-formed and
completely indexed** — not that it is true.

## 6. Hooks: sixty-four one-liners, one voice

Each row carries a hook whose only job is to tell a reader whether to open the file. Written across
nine sittings, they came out more consistent than expected: between roughly ninety and a hundred and
seventy characters, all fragments rather than sentences, all naming a concrete seam.

Twelve of them open with **"Owns the …"**, and that repetition is deliberate rather than
accidental. Several capabilities are described by two guides from different sides — the plan
definition versus the recurrence engine, the tax call-out versus the rate table, the promotion engine
versus the code that unlocks it — and in every such pair exactly one guide owns the shared premise
while the other links to it and restates nothing
([`01-extension-guide-structure-and-template.md`](01-extension-guide-structure-and-template.md) §6).
The hook is where a reader sees which is which without opening either file, so the repeated verb is
carrying information.

## 7. Related reading

- [`docs/extensions/README.md`](../../extensions/README.md) — the index itself.
- [`spec/extension-guides.spec.ts`](../../../spec/extension-guides.spec.ts) — the checks, with their
  reasoning in the header comment.
- [`01-extension-guide-structure-and-template.md`](01-extension-guide-structure-and-template.md) —
  the template, the front-matter contract and the five rails.
- [ADR-055](../../adr/055-where-deliberately-unbuilt-work-is-recorded.md) — which of the three
  records a sentence about something absent belongs in.
- [ADR-053](../../adr/053-how-a-transition-window-closes.md) — the preference for a mechanical
  condition over a review date, which is why `attaches_to` is checked rather than diarised.
