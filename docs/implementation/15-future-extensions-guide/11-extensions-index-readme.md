# The extensions index, and the checks that keep it in step

[`docs/extensions/README.md`](../../extensions/README.md) is the front door to sixty-four capability
sketches. This note covers the finished index: what it holds, the five mechanical checks that keep it
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

Five assertions, each catching a different way the two can drift apart. The first two existed from
the start; the two counts landed once the folder was complete, and the folder check followed when the
guides moved into per-cluster directories.

| Check | What it catches | What it misses on its own |
| --- | --- | --- |
| **Bijection** — every guide linked exactly once, no duplicates | An orphan guide: a file written and never listed. | Nothing, at a known size — but at an *unknown* size it is silent about a guide that was never written at all. |
| **No dead index link** | A row pointing at a file that was renamed or deleted. | A guide that exists but has no row. |
| **Total count** | A guide added or deleted without the index being touched. | Which one, and in which cluster. |
| **Per-cluster counts** | A guide whose **front matter** names the wrong cluster. | A guide whose front matter is right and whose *folder* is wrong — the counts are computed from the front matter. |
| **Folder matches front matter** | A guide sitting in a directory its `cluster` key does not name, from either side. | A guide whose cluster is right and whose content is wrong. |

The last two are the ones that earn their keep, because the failure they catch is otherwise
completely silent. A guide with `cluster: Physical Retail` in a customer-identity file has valid front
matter, six correct sections, live `attaches_to` paths, a resolving title and an index row — **every
other assertion in the file passes.** It is simply missing from the section a reader would look in,
and present in one where it makes no sense. The `cluster` assertion does not see it either: that one
checks the value is one of the nine literal names, which catches a *misspelled* cluster and not a
*misfiled* one.

**The cluster is written twice, and the two can disagree in either direction.** Once as the folder a
guide sits in, once as its `cluster` key; the counts are computed from the second, the reader
navigates by the first. So a file dragged into the wrong folder keeps a correct `cluster` and the
counts still balance — only the folder check notices. A front matter edited in place without moving
the file trips both. The message names the file, the folder it is in and the folder its cluster
names, so a reader can decide which half was intended rather than guessing from a count.

The spec joins the two through a map that spells all nine directory names out, rather than deriving
one from the other. Every entry is what a slugify would produce — lower-case, ` & ` becoming
`-and-` — so the derivation would pass today. **That is the argument against it, not for it.** A
derived expectation compares the naming rule to itself: it cannot fail, and if the convention is ever
changed wholesale it re-derives to the new answer and stays green. Writing the nine out makes the
layout a fact the test pins, so renaming a directory goes red until somebody confirms the rename was
meant.

## 4. Each assertion was seen red before it was trusted

A count assertion that has never failed is a count nobody has verified — it may be comparing a
constant to itself. Each was observed failing, in four separate perturbations chosen so that the
assertion under test is the one that names the cause:

| Perturbation | What went red |
| --- | --- |
| One guide file moved out of the folder | *"holds 63 guides, expected 64"* and *"cluster 'Customer & Identity' holds 6 guides, expected 7"*. The index-link count stayed **green** — correctly: the index still listed sixty-four, the folder had shrunk. |
| One index row unlinked, guide untouched | *"README.md links 63 distinct guides, expected 64"*, alongside the pre-existing orphan check. The total stayed green — the folder was intact. |
| One guide's `cluster` changed to a different valid name, file left where it was | The per-cluster check, naming both sides — the cluster that lost a guide and the one that gained it — **and** the folder check, naming the file. The total and the index-link count both stayed green, which is exactly the blind spot these assertions exist to cover. |
| One guide moved into a different cluster's folder, front matter untouched | **Only the folder check** identifies the cause, and its message names both directories. The per-cluster counts stayed **green** — correctly, since they read the front matter, which was not edited. The link assertions also went red, but they report symptoms (a sibling link and an index row that no longer resolve), not the mistake. |

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
