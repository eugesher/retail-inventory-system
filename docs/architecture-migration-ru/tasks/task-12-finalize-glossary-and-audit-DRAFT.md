# task-12 — Finalize glossary and run guide-wide audit (Phase: glossary + final pass) — DRAFT

> **DRAFT — may be revised by task-01.** This is the **final**
> writing task. Its job is consolidation: collect every glossary
> entry from previous carryovers into `glossary.md`, audit
> wiki-link health across the entire guide, polish the root file,
> and flip every article's `status` to `final`.

## Context

- Migration source of truth: every previous task's carryover
  (`_carryover-02.md` … `_carryover-11.md`) carries a
  `## Glossary terms collected` section. This task consolidates
  them.
- Previous carryover:
  `docs/architecture-migration-ru/tasks/_carryover-11.md`
  (READ FIRST). Also pull `## Glossary terms collected` from
  `_carryover-02.md` through `_carryover-11.md` inclusive.
- Guide root: `docs/architecture-migration-ru/architecture-migration-guide.md`.
- Conventions preamble: see `task-01-survey-and-scaffold.md`.
- Where the guide stands: every article is written and reviewed.
  Most articles are still `status: review`. The orphan/permalink
  gates have passed per-task but no guide-wide audit has run.

## Prerequisites

- [ ] `_carryover-11.md` exists and was read first.
- [ ] Every `_carryover-NN.md` for N in 02..11 has a populated
      `## Glossary terms collected` section.
- [ ] Build is green on entry (`yarn install && yarn build`).
- [ ] HEAD SHA is recorded in `_carryover-01.md`.

## Goal

Produce the final, audited form of the guide. After this task:

- `glossary.md` is the canonical EN→RU term reference, sorted
  alphabetically by English term, with one row per term and a
  list of articles that introduce or use it.
- Every article under `docs/architecture-migration-ru/` (excluding
  `tasks/`) has `status: final`.
- The root `architecture-migration-guide.md` reflects the final
  structure (no stale TOC entries, no broken wiki links).
- The orphan, link-health, and permalink-format audits pass
  guide-wide, not just per-task.

## Article slots to fill

- [ ] `docs/architecture-migration-ru/glossary.md`

> Approximate guidance:
>
> - **glossary** — ~3000 words depending on term count.
>   Frontmatter as for any other article. The body is a single
>   alphabetised table:
>
>   ```markdown
>   | Термин (EN) | Перевод / пояснение (RU) | Введён в |
>   |---|---|---|
>   | Adapter | Адаптер — реализация порта. | [[hexagonal-architecture]] |
>   | Aggregate root | Агрегат — корневой объект… | [[domain-driven-design]] |
>   | …
>   ```

## Steps

1. **Read every previous carryover.** Walk `_carryover-02.md`
   through `_carryover-11.md`. From each, extract every glossary
   row and the article that introduced it.
2. **De-duplicate.** A term may have been introduced more than
   once across articles. Pick the most authoritative Russian
   explanation; cite every article that uses it.
3. **Author `glossary.md`.** Single alphabetised table, frontmatter
   `status: final`. Cross-link liberally from the table back to
   the article slugs.
4. **Run guide-wide audits:**
   - **Orphan audit.** Every file in
     `docs/architecture-migration-ru/` (excluding `tasks/`) must
     be referenced by at least one `[[wiki-link]]` from another
     file (or appear in the root TOC). For each orphan, either
     add the wiki link from a natural anchor or remove the file
     and document the removal in `_carryover-12.md`.
   - **Wiki-link health.** Walk every `[[wiki-link]]` in every
     article. Each must resolve to an existing file. Broken links
     are fixed in this task.
   - **Permalink format.** Every GitHub permalink in every article
     uses the SHA from `_carryover-01.md`, never `main` or a
     branch name. Spot-check via grep:
     ```
     grep -rhE 'github\.com/eugesher/retail-inventory-system/blob/' docs/architecture-migration-ru/ | sort -u
     ```
     Every URL listed must contain the recorded SHA, not a branch.
   - **Frontmatter validity.** Every article has frontmatter with
     `created`, `updated`, `tags`, `status`. Flip `status: review`
     → `status: final` across the guide as part of this audit.
   - **No `заглушка` callouts remain.** Final stub-removal grep:
     ```
     grep -rn 'заглушка' docs/architecture-migration-ru/ || echo "(no matches)"
     ```
5. **Polish the root file.**
   - Walk the TOC against the final folder structure; remove any
     entry that no longer exists; add any entry that was created
     after task-01.
   - Ensure the abstract still describes the guide accurately.
   - Add a "How to read" note for first-time readers (suggested
     reading order: concepts → project-shape → persistence →
     messaging → caching → auth → observability →
     application-layer → quality → glossary).
   - Flip `status: review` → `status: final` on the root file.
6. **Flip article statuses.** Every article in the guide now
   carries `status: final`. Update the `updated:` date to today.

## Verification

- [ ] `glossary.md` exists with frontmatter, alphabetised table,
      and at least one row per glossary term that was collected.
- [ ] `grep -rn 'заглушка' docs/architecture-migration-ru/` returns
      no matches.
- [ ] Every `[[wiki-link]]` resolves.
- [ ] Every GitHub permalink uses the SHA from `_carryover-01.md`.
- [ ] No orphans across the guide.
- [ ] Every article has `status: final` in its frontmatter.
- [ ] The root file's TOC matches the final folder structure
      one-for-one.

## Carryover

Write `docs/architecture-migration-ru/tasks/_carryover-12.md`. This
is the **last** carryover of the writing flow. It must contain:

- `## Glossary entries consolidated` — count + a few notable
  de-duplications.
- `## Orphans found and resolved` — empty if none; otherwise one
  line per fix.
- `## Broken wiki-links found and fixed` — empty if none;
  otherwise one line per fix.
- `## Permalink format violations found and fixed` — empty if none.
- `## Articles flipped to final` — count.
- `## Final guide structure` — directory tree of the deliverable.
- `## Suggested follow-ups for Eugene` — what to do when copying
  the guide into the Obsidian vault (e.g. "delete the `tasks/`
  folder before importing"), what to revisit in 6 months as the
  project evolves, which articles will go stale fastest.
