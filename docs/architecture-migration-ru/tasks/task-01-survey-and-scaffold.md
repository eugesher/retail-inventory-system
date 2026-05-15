# task-01 — Survey inputs and scaffold the guide

> **First task in the writing flow.** This task does not produce any
> article content. It surveys the repository inputs, captures the SHA
> that every subsequent article will permalink against, decides the
> final folder structure, scaffolds stub article files so wiki links
> resolve from day one, and finalizes the downstream task drafts
> (`task-02-…-DRAFT.md` … `task-12-…-DRAFT.md`).

---

## Conventions for every task in this folder

These conventions are stated once here. The drafts and the renamed
downstream tasks link back to this section rather than restating it.

### 1. Self-containment

Each task runs in a **cleared Claude Code context**. The task file
must be sufficient on its own. Every task's "Context" section starts
with:

- pointer to `docs/architecture-migration-plan/` (the source of truth
  for what was built during the migration);
- pointer to the previous task's `_carryover-(NN-1).md` (must be read
  first);
- pointer to `docs/architecture-migration-ru/architecture-migration-guide.md`
  (the scaffolded root file produced by this task);
- one-paragraph statement of where the guide currently stands.

### 2. No Git operations

Tasks run on a pre-configured branch. Do **not** run `git add`,
`git commit`, `git push`, `git branch`, `git checkout`, `git tag`,
`git merge`, or `git stash`. Do **not** modify `.git/`.

`git rev-parse HEAD` is allowed (and required in this task) — read-only.

### 3. No deletion lifecycle

Unlike the migration tasks, nothing in this guide's authoring flow
gets auto-deleted. The `docs/architecture-migration-ru/tasks/` folder
and every `_carryover-NN.md` stay in the repository until Eugene
removes them manually. Do not include any "delete this folder before
merge" instruction in any task — it does not apply here.

### 4. Scratch vs deliverable

- **Deliverable** (lives in `docs/architecture-migration-ru/`,
  excluding `tasks/`): the root file, the folder tree, every article.
- **Scratch** (lives in `docs/architecture-migration-ru/tasks/`): the
  task files, the `_carryover-NN.md` files. Useful during authoring;
  removed manually by Eugene when the guide is complete.

Anything that must survive into the final guide lands in a real
article, not a carryover.

### 5. GitHub permalink discipline

Every code reference in every article must include a GitHub permalink
pinned to the SHA captured by this task — never `main`, never a
branch name. The format is:

```
https://github.com/eugesher/retail-inventory-system/blob/<SHA>/<path>#L<start>-L<end>
```

Tasks read the SHA from `_carryover-01.md` (see step 2 below). If the
SHA section is missing, the task fails fast with a clear error rather
than guessing.

If an article cites a range of lines that doesn't exist at the SHA
(because the file was refactored mid-authoring), widen the range or
pick different code — do not invent line numbers.

### 6. Orphan and link discipline

After writing or editing any article, every file under
`docs/architecture-migration-ru/` (excluding `tasks/`) must be linked
from at least one other file. Newly authored articles must be added
to either the root file's table of contents, a parent topic article's
"Связанные решения" section, or a peer article's body — and linked
back in turn.

### 7. Stub-fill discipline

This task scaffolds every article slot as a stub with frontmatter and
a `> [!warning] Заглушка — статья ещё не написана` callout. As writing
tasks complete an article, they remove the warning, set
`status: draft` → `status: review` once content is present, and update
the `updated:` date. The final task (audit) flips everything to
`status: final` once cross-references and the glossary are
consolidated.

### 8. Verification gate

Every task ends with a verification block. Mandatory:

- the task's stated article slots are no longer stubs (no `заглушка`
  callout remains in articles touched by this task);
- every code excerpt in every article touched by this task has an
  accompanying GitHub permalink;
- every wiki link in every article touched by this task resolves to a
  file that exists;
- no article touched by this task is below ~600 words unless the task
  body explicitly exempts it (a one-line adapter article may be
  shorter).

If any check fails, the task marks itself **BLOCKED** in
`_carryover-NN.md`, stops, and does not paper over the failure.

### 9. Granularity

A task is the right size when it produces, in one Claude Code session,
3–8 articles or one large article. If a task's slot list is longer
than that, split it.

### 10. Task file template

Every task file uses this skeleton:

```markdown
# task-NN — <title>

## Context
- Migration source of truth: `docs/architecture-migration-plan/`
- Previous carryover: `docs/architecture-migration-ru/tasks/_carryover-(NN-1).md`
  (READ FIRST)
- Guide root: `docs/architecture-migration-ru/architecture-migration-guide.md`
- HEAD SHA for permalinks: read from `_carryover-01.md`
- Where the guide stands: <one paragraph>

## Prerequisites
- [ ] `_carryover-(NN-1).md` exists and was read first
- [ ] Build is green on entry
- [ ] HEAD SHA is recorded in `_carryover-01.md`
- [ ] <task-specific prerequisites>

## Goal
<single-paragraph statement>

## Article slots to fill
- [ ] `docs/architecture-migration-ru/<group>/<article>.md`
- [ ] `docs/architecture-migration-ru/<group>/<article>.md`
…

## Steps
1. Read previous carryover.
2. For each article slot, write the article following the standard skeleton.
3. Cross-link articles within and across groups.
4. <task-specific>

## Verification
- [ ] Every article slot listed above is filled (no "заглушка" callout left)
- [ ] Every code excerpt has a GitHub permalink pinned to the recorded SHA
- [ ] Every wiki link resolves
- [ ] No orphans under `docs/architecture-migration-ru/`
- [ ] Frontmatter present and valid on every touched file

## Carryover
Write `docs/architecture-migration-ru/tasks/_carryover-NN.md` with:
- Articles written (paths + one-line summaries)
- Articles deferred (with reasons)
- Cross-references added between articles
- Glossary terms collected (will be consolidated in the final task)
- Verification results
- Suggested adjustments to upcoming tasks
```

### 11. Article skeleton (used by every writing task)

```markdown
---
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
tags: [retail-inventory-system, <topic-tags>]
status: draft | review | final
related:
  - "[[<wiki-link>]]"
  - "[[<wiki-link>]]"
---

# <Title in Russian>

> [!abstract] Кратко
> 1–3 sentence Russian summary. What the article covers and why it
> matters for the Retail Inventory System.

## Проблема, которую решает

Russian prose. What concrete pain or requirement led to this decision /
technology / library being adopted. Anchor to the actual project:
which service, which module, what was happening before.

## Концепция

(Concept articles only — skip for pure library articles, which fold
this into the next section.) Russian prose explanation of the pattern
from first principles. Aim for a mid-level NestJS reader. Use mermaid
diagrams where they help. Cover:

- What the pattern *is*
- The problem it solves
- The trade-offs
- When to use it / when not to use it
- Common anti-patterns

## Применение в проекте

The senior-level section. For every code reference:

1. A file path as a fenced-code-block header
2. An inline excerpt (5–40 lines, focused — never the whole file)
3. A GitHub permalink to the same lines, pinned to the SHA captured
   in this task

Format:

` ` `typescript
// apps/retail-microservice/src/modules/orders/application/use-cases/create-order.use-case.ts
@Injectable()
export class CreateOrderUseCase {
  // ...
}
` ` `

> [GitHub: apps/retail-microservice/src/modules/orders/application/use-cases/create-order.use-case.ts](https://github.com/eugesher/retail-inventory-system/blob/<SHA>/apps/retail-microservice/src/modules/orders/application/use-cases/create-order.use-case.ts#L1-L40)

Explain what the code does, what it depends on, and how it ties back
to the concept.

## Связанные решения

Wiki links to other articles in the guide that this one touches.

## Глоссарий

| Термин (EN) | Перевод / пояснение (RU) |
|---|---|
| Port | Порт — интерфейс, описывающий... |
| Adapter | Адаптер — реализация порта... |

## Что почитать дальше

(Optional.) External references — books, conference talks, official
docs. 1–5 items, never a link dump.
```

### 12. Conventions every article must follow

1. **Russian prose, English technical identifiers.** Class names, file
   paths, method signatures, library names, log levels, HTTP verbs,
   environment variable names — English. Surrounding prose — Russian.
2. **Obsidian frontmatter** is mandatory and uses the schema above.
3. **Wiki-style internal links** (`[[article-slug]]`) — mandatory for
   cross-article references. Plain Markdown links only for external
   URLs and GitHub permalinks.
4. **A "Глоссарий" section** is mandatory — pairs English terms with
   Russian explanations. Even one row is acceptable; do not skip the
   section.
5. **Callouts** (`> [!note]`, `> [!warning]`, `> [!tip]`, `> [!faq]`,
   `> [!abstract]`) — recommended where they add value, not forced.
   The "Кратко" `> [!abstract]` block at the top is the one exception:
   it is mandatory.
6. **Self-check questions** in a collapsible block — recommended for
   concept articles, optional elsewhere.
7. **Word count** is topic-driven. Soft floor ~600 words, soft ceiling
   ~3000 words. Library articles that are pure adapters
   (e.g. `lib-opentelemetry-resources.md`) can be at the floor;
   foundational concept articles (hexagonal, OpenTelemetry overview)
   will be near the ceiling.
8. **No orphans.** Every article in `docs/architecture-migration-ru/`
   (excluding `tasks/`) must be linked from at least one other
   article.
9. **Production-realistic code excerpts.** Use the actual code from
   this project. No toy examples, no `class Foo`. If a library
   article needs to illustrate the library in isolation, also show
   how *this project* uses it.

### 13. Stack-overview vs library articles

For the three clarification groups (cache, auth, observability):

- the **stack overview** article explains how the libraries cooperate
  end-to-end, with a diagram and a layered breakdown;
- the **per-library** article zooms into one library's role within
  the stack: what it does, what it does **not** do (critical for
  stacks like cache-manager / keyv / @keyv/redis / cacheable where
  the roles overlap superficially), what API surface this project
  uses, and the exact code where it is wired in.

A reader should be able to answer, after reading the cache stack:

- Why is there both `cache-manager` and `keyv`?
- What does `@keyv/redis` add on top of `keyv`?
- What does `cacheable` give us that `cache-manager` alone does not?
- What does `@nestjs/cache-manager` wrap, and what does it leave
  alone?

Same shape for auth (passport vs `@nestjs/passport` vs `passport-jwt`
vs `@nestjs/jwt` vs `argon2`) and observability (every
`@opentelemetry/*` package's role).

---

## Context

- **Migration source of truth.** Every architectural decision the
  guide describes is anchored in:
  - `docs/adr/*.md` — 20 Architecture Decision Records (ADR-001 …
    ADR-020).
  - `docs/architecture-migration-plan/parts/*.md` — the original
    research deliverable (project audit, boilerplate comparison,
    recommendation, migration checklist, sources).
  - `docs/architecture-migration-plan/tasks/*.md` and
    `_carryover-*.md` — the executed task scripts and their
    handover notes. **The carryovers are the ground truth for what
    was actually built**; the upstream task files are intent, the
    carryovers are the receipt.
- **Project conventions.** `CLAUDE.md` and `README.md` together
  document the current shape of the codebase. Both are kept in sync
  with the ADRs.
- **Code.** `apps/*/src/**` and `libs/*/src/**` are the implementations.
  The guide cites them directly via permalinks, so the structure
  must be inventoried.
- **The guide is a self-contained Obsidian sub-tree.** While it lives
  in `docs/architecture-migration-ru/` during authoring, it must not
  depend on the repository's own README/CLAUDE.md to be readable. It
  is intended to be copied into Eugene's Obsidian vault when complete.

## Prerequisites

- [ ] `docs/adr/` is readable end-to-end (20 ADRs + `index.md`).
- [ ] `docs/architecture-migration-plan/parts/` and
      `docs/architecture-migration-plan/tasks/` are readable
      end-to-end (5 plan parts; 14 task scripts; 14 carryovers).
- [ ] `package.json` and `yarn.lock` are readable.
- [ ] `CLAUDE.md` and `README.md` are readable.
- [ ] Repository builds on entry — run `yarn install && yarn build`
      as a smoke test. If it fails, mark **BLOCKED** in
      `_carryover-01.md`.

## Goal

Survey every input, capture the HEAD SHA for permalinks, decide the
final folder structure of the guide, scaffold the directory and stub
article files, and finalize the downstream task drafts so the rest of
the writing pipeline runs against locked scope.

## Steps

1. **Inventory inputs.** Read every file listed under "Context". For
   each, capture in a written inventory:
   - **Decisions.** For every ADR: number, slug, status, what it
     decides, and which executed task created it.
   - **Technologies.** Every framework, ORM, broker, observability
     stack, cache layer, lint tool, etc. that the migration adopted
     or kept. Cross-reference each against `package.json` to confirm
     the version actually shipped.
   - **Libraries.** Every entry in `package.json` `dependencies` and
     `devDependencies`. Group them by stack (cache, auth, OTel,
     etc.) and flag any whose role isn't obvious from the name.
   - **Per-task delta.** For each executed migration task, capture
     in one line what shipped (read the matching carryover, not the
     upstream task script).

   Save the inventory to `_carryover-01.md` (see step 7).

2. **Capture HEAD SHA.** Run `git rev-parse HEAD` and store the
   output verbatim in `_carryover-01.md` under a section literally
   titled `## HEAD SHA for permalinks`. All subsequent tasks read
   this section to construct GitHub permalinks. Format used by
   articles:

   ```
   https://github.com/eugesher/retail-inventory-system/blob/<SHA>/<path>#L<start>-L<end>
   ```

3. **Verify the proposed folder layout** against the inventory.

   The working hypothesis is the layout below. It comes from the
   orchestrator prompt and is informed by the 20 ADRs, the executed
   tasks, and the dependency stack. Edit it where the inventory
   contradicts it; do not silently keep slots that the migration
   didn't actually deliver.

   ```
   docs/architecture-migration-ru/
   ├── architecture-migration-guide.md         ← root: high-level overview + links
   ├── concepts/
   │   ├── hexagonal-architecture.md
   │   ├── domain-driven-design.md
   │   ├── clean-architecture-layers.md
   │   ├── module-boundaries.md
   │   └── architecture-decision-records.md
   ├── project-shape/
   │   ├── nestjs-monorepo.md
   │   ├── microservices-split.md
   │   ├── api-gateway-pattern.md
   │   └── shared-libs-philosophy.md
   ├── persistence/
   │   ├── typeorm-overview.md
   │   ├── entity-vs-domain-model.md
   │   ├── mappers-and-repositories.md
   │   ├── base-entity-and-base-repository.md
   │   └── snake-naming-strategy.md
   ├── messaging/
   │   ├── rabbitmq-as-bus.md
   │   ├── nest-microservices-transport.md
   │   ├── message-vs-event-patterns.md
   │   └── routing-keys-and-contracts.md
   ├── caching/
   │   ├── cache-aside-pattern.md
   │   ├── cache-stack-overview.md
   │   ├── lib-nestjs-cache-manager.md
   │   ├── lib-cache-manager.md
   │   ├── lib-keyv.md
   │   ├── lib-keyv-redis.md
   │   └── lib-cacheable.md
   ├── auth/
   │   ├── jwt-and-rbac.md
   │   ├── auth-stack-overview.md
   │   ├── lib-nestjs-passport.md
   │   ├── lib-passport.md
   │   ├── lib-passport-jwt.md
   │   ├── lib-nestjs-jwt.md
   │   └── lib-argon2.md
   ├── observability/
   │   ├── opentelemetry-overview.md
   │   ├── pino-logging.md
   │   ├── trace-log-correlation.md
   │   ├── jaeger-backend.md
   │   ├── lib-opentelemetry-api.md
   │   ├── lib-opentelemetry-sdk-node.md
   │   ├── lib-opentelemetry-auto-instrumentations-node.md
   │   ├── lib-opentelemetry-instrumentation-amqplib.md
   │   ├── lib-opentelemetry-exporter-trace-otlp-http.md
   │   ├── lib-opentelemetry-core.md
   │   ├── lib-opentelemetry-resources.md
   │   └── lib-opentelemetry-semantic-conventions.md
   ├── application-layer/
   │   ├── use-cases-vs-fat-services.md
   │   ├── dto-by-direction.md
   │   └── notifier-port-and-adapters.md
   ├── quality/
   │   ├── lib-eslint-plugin-boundaries.md
   │   └── test-strategy.md
   └── glossary.md
   ```

   - **Add** an article slot for any decision/technology/library that
     the inventory shows was adopted but is not represented above.
   - **Remove** an article slot for any proposed entry that the
     inventory shows doesn't actually apply (e.g. a library Eugene
     planned to use but the migration didn't ship).
   - **Adjust nesting** where it would read more naturally. There is
     no fixed depth; flatten or split groups where the article
     count is lopsided.

   Capture the final structure in `_carryover-01.md` under
   `## Final folder structure`.

4. **Confirm clarification-group membership.** The orchestrator has
   explicitly flagged these packages as needing per-library articles
   (alongside the stack-overview article in each group). Confirm
   each is present in `package.json`:

   - **Cache stack:** `@nestjs/cache-manager`, `cache-manager`,
     `keyv`, `@keyv/redis`, `cacheable`.
   - **Auth stack:** `@nestjs/jwt`, `@nestjs/passport`, `passport`,
     `passport-jwt`, `argon2`.
   - **Observability stack:** `@opentelemetry/api`,
     `@opentelemetry/auto-instrumentations-node`,
     `@opentelemetry/core`,
     `@opentelemetry/exporter-trace-otlp-http`,
     `@opentelemetry/instrumentation-amqplib`,
     `@opentelemetry/resources`,
     `@opentelemetry/sdk-node`,
     `@opentelemetry/semantic-conventions`.
   - **Quality:** `eslint-plugin-boundaries`.

   Every one of these must have a dedicated `lib-*.md` article. If
   any of them is not actually in `package.json`, surface the
   discrepancy in `_carryover-01.md` under `## Discrepancies` before
   proceeding. Do not silently drop an article — the orchestrator
   expects to make that call.

5. **Scaffold the folder tree.** Create the directory structure under
   `docs/architecture-migration-ru/` as decided in step 3. For each
   article slot, create a stub `.md` file containing only:

   - frontmatter (created/updated/tags/status: `draft`/related: `[]`);
   - the H1 title in Russian;
   - a single callout body:

     ```markdown
     > [!warning] Заглушка — статья ещё не написана
     > Этот файл — заготовка, создаваемая task-01. Содержимое будет
     > наполнено в одной из последующих writing-задач.
     ```

   This makes every wiki link resolve immediately and lets the
   orphan audit run from task-02 onward. Use a kebab-case slug
   matching the filename for the H1's intended wiki-link target.

6. **Create the root file.** Write
   `docs/architecture-migration-ru/architecture-migration-guide.md`
   with:

   - frontmatter (status: `draft`);
   - one `> [!abstract] Кратко` block in Russian (~80 words) stating
     what the guide is and who it's for;
   - a Russian overview of the migration (~300–500 words):
     - что было до миграции (flat services, fat `libs/common`, нет
       auth, нет OTel);
     - что мы получили после (per-module hexagonal,
       `@retail-inventory-system/*` libs, JWT/RBAC, OTel+Jaeger,
       eslint-plugin-boundaries);
     - как читать гид (последовательно от concepts до quality, или
       выборочно по нужным группам);
   - a structured table of contents — **every** top-level area
     (`concepts/`, `project-shape/`, …) gets a section heading; every
     stub article gets a `[[wiki-link]]` plus a one-line Russian
     description.

   The root file is the **entry point** and the linker of last
   resort: any article that isn't referenced from a group peer must
   at minimum be referenced here. This is what makes the
   "no orphans" gate pass from day one.

7. **Review and finalize the draft tasks.** Open every
   `task-NN-…-DRAFT.md` in this folder. For each:

   - Confirm its article slot list matches the verified folder
     structure from step 3. Edit if not.
   - If the slot list is longer than the granularity rule allows
     (3–8 articles or one large article), **split** it. Renumber
     downstream files to keep the sequence contiguous with two-digit
     padding.
   - If two adjacent drafts cover the same group thinly,
     **merge** them.
   - If a draft has been obviated by the inventory (e.g. its whole
     topic group doesn't actually apply), **delete** it.
   - If the inventory turned up a topic group that no draft covers,
     **add** a new task in the right position.

   When the draft set is final:

   - rename `…-DRAFT.md` → `…md` (drop the `-DRAFT` suffix);
   - in the renamed file, update the "where the guide stands"
     paragraph in its Context section so the executing session sees
     the correct picture;
   - if any earlier draft referenced a file path that has since
     changed, fix the reference.

   Record the final task list in `_carryover-01.md` under
   `## Final task list` (with the new filenames).

8. **Write `_carryover-01.md`.** The carryover must contain, in this
   order:

   1. `## Entry-gate result` — `yarn install && yarn build` outcome.
   2. `## HEAD SHA for permalinks` — the `git rev-parse HEAD`
      output, as a single fenced block.
   3. `## Inventory` — three subsections:
      - `### Decisions` — table of ADR-NNN, slug, status, one-line
        decision, originating task.
      - `### Technologies` — table of stack → tool → version → role.
      - `### Libraries` — table of every `dependencies` /
        `devDependencies` entry → group → role.
      - `### Migration deltas` — one line per executed task summarising
        what shipped (sourced from the carryover, not the task script).
   4. `## Final folder structure` — the directory tree, as a fenced
      block.
   5. `## Stub files created` — flat list of every article path.
   6. `## Discrepancies` — empty if none; otherwise one line per
      finding (e.g. "library X is in `package.json` but no executed
      task wired it in").
   7. `## Final task list` — table of NN → filename → topic group →
      article count.
   8. `## Notes for downstream tasks` — anything unexpected the
      survey turned up that future writers must know.

## Documentation updates required

**None inside this repository.** The guide is a standalone external
artifact targeted at Eugene's Obsidian vault. Do not update
`README.md` or `CLAUDE.md`; the existence of the guide is intentional
and does not change the codebase's own living documentation.

## Verification

- [ ] `yarn install` succeeds.
- [ ] `yarn build` succeeds for all four apps (smoke check only —
      the guide is docs-only and does not introduce code changes).
- [ ] Every directory in the final folder structure exists under
      `docs/architecture-migration-ru/`.
- [ ] Every stub `.md` file exists and contains valid frontmatter +
      the `заглушка` callout.
- [ ] `docs/architecture-migration-ru/architecture-migration-guide.md`
      exists, contains the abstract + overview + TOC, and links to
      every stub via a `[[wiki-link]]`.
- [ ] Every `[[wiki-link]]` in the root file resolves to a stub that
      exists on disk.
- [ ] No file in `docs/architecture-migration-ru/` outside `tasks/`
      is orphaned — every stub is linked from the root file at
      minimum.
- [ ] `_carryover-01.md` contains the eight required sections, in
      order, with the HEAD SHA section clearly labeled.
- [ ] Every previously-DRAFT task in this folder has been renamed
      and its Context section updated.
- [ ] No `git` mutating commands were run.

If any check fails, mark the task **BLOCKED** in `_carryover-01.md`,
stop, and do not proceed.

## Carryover

Write `docs/architecture-migration-ru/tasks/_carryover-01.md` with
the eight sections specified in step 8 above. The HEAD SHA section
is load-bearing for every downstream task — if it is missing or
malformed, downstream tasks must refuse to run rather than guess.
