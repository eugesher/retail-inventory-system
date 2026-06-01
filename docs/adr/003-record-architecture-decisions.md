# ADR-003: Record Architecture Decisions

- **Date**: 2026-05-08
- **Status**: Accepted

---

## Context

The retail-inventory-system has grown enough architectural decisions —
Pino + correlation IDs (ADR-001), Redis cache-aside for product stock
(ADR-002), and the full hexagonal-architecture migration that began
around the time this ADR was written — that the *why* behind each
choice has started leaking into PR descriptions, commit messages, and
maintainer memory. None of those survive long-term: PR descriptions
are searchable but inconvenient; commit messages compress decisions
into a sentence; memory rotates with team churn. Future decisions
(per-service hexagonal layout, lib split, JWT/RBAC introduction,
OpenTelemetry + Jaeger, eslint architecture rules) will compound the
problem.

A persistent format that records each decision next to the code it
governs, dated and numbered for cross-reference, removes the need to
reconstruct rationale from history. Two existing ADRs already use a
hybrid Nygard / MADR shape (Status, Context, Decision, Alternatives
Considered, Consequences); this ADR codifies that shape and the
3-digit-padded numbering convention so future entries are uniform
without per-author negotiation.

---

## Decision

We will record significant architectural decisions in this project as
ADRs under [`docs/adr/`](.).

**Format.** Each ADR uses the existing Nygard hybrid layout established
by [ADR-001](001-structured-logging-with-pino.md) and
[ADR-002](002-redis-cache-aside-product-stock.md):

- Title: `# ADR-NNN: <decision in active voice>`.
- A `**Date**` and a `**Status**` line at the top
  (Status is one of: Proposed, Accepted, Superseded by ADR-NNN,
  Deprecated, Rejected).
- `## Context` — what problem the decision answers and what
  forces shape it. State the situation as it actually is in this
  codebase, not in the abstract.
- `## Decision` — what was decided, in concrete enough detail
  that a future reader can recognize the decision in code without
  needing the author present.
- `## Alternatives Considered` — at least one rejected option,
  with a one-paragraph reason. This block is what makes the ADR
  defensible later: "we considered X and rejected it because Y."
- `## Consequences` — both Positive and Negative / Trade-offs.
  Honest about the costs the decision imposes.

**Numbering.** ADRs are numbered with **3-digit zero-padded** integers
starting at 001 (`001-structured-logging-with-pino.md`). The next free
number is 004 at the time of writing (003 is this ADR). Numbers are
allocated when the file is first committed; do not reserve numbers in
advance. If a decision is later reversed, write a new ADR that
**Supersedes** the old one; do not edit the old ADR in place beyond
flipping its `Status` and adding a one-line pointer.

**Slug.** File name is
`docs/adr/NNN-<short-kebab-case-slug>.md`. The slug summarizes the
decision, not the area; prefer
`004-adopt-hexagonal-architecture-per-service.md` over
`004-architecture.md`.

**When to write one.** Any of:

- A choice between two or more reasonable alternatives that future
  contributors might second-guess.
- A constraint imposed on the codebase (e.g., "domain layers may not
  import from `@nestjs/*`").
- A reversal or supersession of a prior ADR.

A bug fix is not an ADR. A refactor that does not change boundaries
is not an ADR. Adding a dependency for ergonomic reasons is not an
ADR. Adding a dependency that locks the project into a class of
solutions (e.g., switching ORMs) **is** an ADR.

**Index.** [`docs/adr/index.md`](.) was added as a follow-up step and
lists every ADR with number, title, status, date, and a one-line
summary. Until it existed, the directory listing served as the index.

---

## Alternatives Considered

**4-digit padding (`0001-…`).** The MADR template and many open-source
projects use 4-digit zero-padding. Rejected for this project because
ADRs 001 and 002 already exist on `main` with 3-digit padding;
renumbering them ahead of the migration would touch every existing
README and audit-doc reference for cosmetic gain.

**Strict MADR template (with `## Considered Options` table, decision
drivers, etc.).** Rejected as heavier than this project needs at its
current scale. The Nygard hybrid in ADR-001/ADR-002 already includes
"Alternatives Considered" — the most important MADR field — and adds
"Consequences," which MADR lacks by default. Mixing in MADR's full
template later is a non-breaking change if the project grows into it.

**No ADRs; rely on PR descriptions and commit messages.** Rejected for
the reason stated in Context: PR descriptions are searchable but
inconvenient, and commit messages compress decisions into sentences
that lose the *why* within months.

---

## Consequences

### Positive

- A new contributor can read `docs/adr/` end-to-end and understand the
  shape of the system without spelunking through git history.
- Architectural drift is easier to spot: if a PR contradicts an
  Accepted ADR, reviewers have a concrete reference to point at.
- Migrations, deprecations, and reversals leave a trail. An ADR's
  Status field is the single source of truth on whether a decision
  is still in force.

### Negative / Trade-offs

- ADR maintenance is on every contributor — writing one is a few
  hundred words of work that doesn't ship features. The hybrid
  template above keeps the floor low (no decision drivers, no
  scoring matrix) but the floor is non-zero.
- The 3-digit cap allows up to 999 ADRs. If we ever approach that,
  switching to 4-digit padding will require renumbering — accepted as
  a long-tail problem unlikely to materialize.
- "Significant" is judgment-dependent. The list under "When to write
  one" above narrows the call but does not eliminate it; expect
  occasional disagreements on whether a change warrants an ADR.
