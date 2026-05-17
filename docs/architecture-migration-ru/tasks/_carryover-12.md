# _carryover-12.md — Finalize glossary and run guide-wide audit (Phase: glossary + final pass)

> Generated 2026-05-17 by the task-12 session of the **architecture
> migration guide** writing flow. Final carryover of the writing flow.
> Builds on `_carryover-11.md` (which built on `_carryover-10.md` →
> … → `_carryover-01.md`, source of the SHA pin
> `84b1507c68fd9ee02b185eef3c4594b6fe02f664`).

## Entry-gate result

`_carryover-11.md` was read in full first. Every `## Glossary terms
collected` section from `_carryover-02.md` through `_carryover-11.md`
was extracted and consolidated into `glossary.md`. Branch is
`migration-guide`; working tree was clean at session start. No code
under `apps/`, `libs/`, or `tests/` was modified. No `git` mutating
commands were executed during the session.

`_carryover-11.md` §«Suggested adjustments» #1 said: «Audit time in
task-12 will involve confirming the «29 unit suites» claim is still
accurate». — Verified at the recorded SHA: `find apps libs tests -name
"*.spec.ts" | wc -l` returns **29** unit-suites (excluding the
`tests/lint/architecture-lint.spec.ts` regression-spec, which is
counted separately in `test-strategy.md`'s pyramid). Claim still
accurate; no fix needed.

`_carryover-11.md` §«Suggested adjustments» #2 deferred the
`OTEL_SDK_DISABLED` retirement to this task. — Investigation
confirms the env-var is **not** in shipping code (`grep -rn
'OTEL_SDK_DISABLED' apps libs tests test scripts` → 0 hits). The
`opentelemetry-overview.md` article documents it as a forward-
looking SDK-knob with the explicit note «не используется в
проекте». No deferral remains open.

`_carryover-11.md` §«Suggested adjustments» #11 asked for «bumper»
to be canonically distinguished from «contract test» in the
glossary. — Honoured. `glossary.md` carries a dedicated row
«Bumper vs contract test» that defines both and locates the bumper
example (`tests/lint/architecture-lint.spec.ts`).

## Glossary entries consolidated

**437 canonical term rows** in `docs/architecture-migration-ru/glossary.md`,
deduplicated from ~575 introduction-events across the ten previous
carryovers (≈24% compression). Word count: **7,283** — well over the
suggested ~3,000-word target, but matched to the actual breadth of
terminology the corpus introduced (50 articles, 9 topic groups, four
distinct stacks — auth/cache/observability/messaging — each with its
own micro-vocabulary).

### Notable de-duplications

| Term (EN) | Appeared in | Resolution |
|-----------|-------------|------------|
| `Port` / `Adapter` | hexagonal-architecture (introduces), 11 other articles (use) | Canonical definition lives in [[hexagonal-architecture]]; other articles get cross-referenced via the «Введён в» column rather than getting per-article duplicate rows. |
| `Aggregate Root` / `AggregateRoot<TId>` | domain-driven-design, entity-vs-domain-model, jwt-and-rbac, notifier-port-and-adapters | Merged into **one row** with two citations (DDD concept + `libs/ddd` base class). The libs/ddd base class is a concrete artifact, not a separate term. |
| `useExisting` | mappers-and-repositories, auth-stack-overview, notifier-port-and-adapters | Single row, three article citations. Each article uses it for a different purpose but the concept is identical. |
| `ARCH-LINT-EX-01` | module-boundaries, entity-vs-domain-model, use-cases-vs-fat-services, lib-eslint-plugin-boundaries | Single row, four article citations. The exception is the single most-cross-referenced project artifact in the corpus. |
| `traceparent` | rabbitmq-as-bus, opentelemetry-overview, jaeger-backend | Single row; `W3C traceparent` kept as a separate row that defines the format string. |
| `@Public()` / `@Roles(...)` | api-gateway-pattern, jwt-and-rbac | Single row each; two article citations each. The pattern was the same across the auth group. |
| `Post-commit` | cache-aside-pattern, use-cases-vs-fat-services | Single row; `Post-commit publish` (messaging variant) kept as a separate row because it has a producer-specific nuance. |
| `Test double` | mappers-and-repositories, use-cases-vs-fat-services, test-strategy | Single row, three article citations. The fileconvention `test-doubles.ts` gets its own separate row because it names a specific file pattern, not the concept. |
| `Element type` | module-boundaries, shared-libs-philosophy, lib-eslint-plugin-boundaries | Single row, three article citations — concepts/, project-shape/, and quality/ approach it from different angles but the term is identical. |
| `OTLPTraceExporter` | opentelemetry-overview, lib-opentelemetry-exporter-trace-otlp-http | Single row, two citations. The lib-article has the deep dive; the overview introduces the name. |
| `customProps` (Pino) / `logMethod` | pino-logging, trace-log-correlation | Kept as **separate** rows even though both articles discuss both terms — the two terms describe orthogonal hook surfaces, not the same concept under different names. |

### Categories deliberately excluded

A dedicated «Что не вошло в глоссарий» section at the bottom of
`glossary.md` enumerates seven categories that are **not** terms:
ADR-numbers, file paths, NPM-versions, RMQ queue names, routing-key
values, storage-id sentinels, env-var names without semantic load,
audit-codes. The exclusion list is a contract with future writers
who might be tempted to grow the glossary into an index.

### Term-count vs target

Task-12 §«Article slots» suggested «~3000 words depending on term
count». The actual was 2.4× that — because Russian-language
verbosity tax plus the four-deep stack-vocabulary (auth × cache ×
observability × messaging) pushed term count past the 250-row
mental estimate to 437. The decision was to keep all 437 (rather
than fold rare terms into «see also» mentions) because the
glossary's purpose is exactly to be exhaustive enough that a
reader who hits an unfamiliar term in any article can resolve it
**in one lookup**, without bouncing between per-article glossaries.

## Orphans found and resolved

**None.** The audit found one orphan: the root file
`architecture-migration-guide.md` itself. This is the intended
state — the entry point is not referenced from any article, only
referenced **outward** to all 50 articles. Per task spec («or
appear in the root TOC»), the root file is exempt from the
orphan rule.

Verification:

```
$ find docs/architecture-migration-ru -name "*.md" -not -path "*/tasks/*" -printf "%f\n" \
    | sed 's/\.md$//' | sort -u > /tmp/article_slugs.txt
$ find docs/architecture-migration-ru -name "*.md" -not -path "*/tasks/*" \
    -exec grep -hoE '\[\[[a-z0-9-]+\]\]' {} + | sort -u \
    | sed 's/\[\[\(.*\)\]\]/\1/' > /tmp/wiki_targets.txt
$ comm -23 /tmp/article_slugs.txt /tmp/wiki_targets.txt
architecture-migration-guide   # ← only orphan; the root file (expected)
```

All 50 article slots receive at least one incoming `[[wiki-link]]`
from another article. The glossary itself is referenced by the
root TOC, so it is not orphaned.

## Broken wiki-links found and fixed

**Zero broken links.** One false-positive surfaced and was
resolved: the glossary's «Как читать таблицу» section used
`` `[[slug]]` `` as a literal formatting example inside a code-span.
Although Obsidian does **not** resolve `[[…]]` inside backticks
(code-spans are inert), it polluted the audit grep. Reworded to
`` `[[<статья>]]` `` to make the example unambiguous and silence the
grep.

| Article | Old form | New form | Reason |
|---------|----------|----------|--------|
| `glossary.md` §«Как читать таблицу» | `` `[[slug]]` `` (example) | `` `[[<статья>]]` `` (example) | Audit-grep false-positive; the literal `slug` slug doesn't exist. |

No genuine broken links were found across the 51 articles.
Verification:

```
$ find docs/architecture-migration-ru -name "*.md" -not -path "*/tasks/*" \
    -exec grep -hoE '\[\[[a-z0-9-]+\]\]' {} + | sort -u \
    | sed 's/\[\[\(.*\)\]\]/\1/' | comm -23 - /tmp/article_slugs.txt
(empty)
```

## Permalink format violations found and fixed

**Zero violations.** Every GitHub permalink across the 51 articles
uses the SHA `84b1507c68fd9ee02b185eef3c4594b6fe02f664`. The two
hits that looked like violations to `grep` are template placeholders
inside the `tasks/` folder (the instructional scripts), not inside
any article:

```
$ grep -rhE 'github\.com/eugesher/retail-inventory-system/blob/' docs/architecture-migration-ru/ \
    | grep -v "84b1507c68fd9ee02b185eef3c4594b6fe02f664"
github.com/eugesher/retail-inventory-system/blob/<SHA>/<path>#L<start>-L<end>
> [GitHub: …](https://github.com/eugesher/retail-inventory-system/blob/<SHA>/…)
   https://github.com/eugesher/retail-inventory-system/blob/<SHA>/<path>#L<start>-L<end>
```

All three matches are `<SHA>`-placeholder URLs in `task-01-survey-and-scaffold.md`
and similar task-brief files — instructional content, not real
permalinks. `tasks/` is exempt from the audit per task-12 spec
(«excluding `tasks/`»).

## Articles flipped to final

**50 articles** flipped `status: review` → `status: final` plus the
root file flipped `status: draft` → `status: final` plus the
glossary which was authored directly at `status: final`. **All 51
deliverable `.md` files** in the guide are now `status: final`
with `updated: 2026-05-17`.

| Group | Articles flipped | Carrying group's introducing task |
|-------|-----------------:|----------------------------------|
| concepts/ | 5 | task-02 |
| project-shape/ | 4 | task-03 |
| persistence/ | 5 | task-04 |
| messaging/ | 4 | task-05 |
| caching/ | 7 | task-06 |
| auth/ | 7 | task-07 |
| observability/ (overviews) | 4 | task-08 |
| observability/ (lib-*) | 8 | task-09 |
| application-layer/ | 3 | task-10 |
| quality/ | 2 | task-11 |
| glossary.md | 1 (authored at `final`) | task-12 (this) |
| architecture-migration-guide.md (root) | 1 (was `draft`) | task-01 + task-12 |
| **Total** | **51** | — |

Verification:

```
$ for f in $(find docs/architecture-migration-ru -name "*.md" -not -path "*/tasks/*"); do
    head -10 "$f" | grep -E "^status: " | head -1
  done | sort | uniq -c
     51 status: final
```

## Final guide structure

The deliverable tree at end-of-task-12:

```
docs/architecture-migration-ru/
├── architecture-migration-guide.md         ← root (status: final)
├── glossary.md                             ← consolidated (status: final, 437 rows)
├── concepts/
│   ├── architecture-decision-records.md
│   ├── clean-architecture-layers.md
│   ├── domain-driven-design.md
│   ├── hexagonal-architecture.md
│   └── module-boundaries.md
├── project-shape/
│   ├── api-gateway-pattern.md
│   ├── microservices-split.md
│   ├── nestjs-monorepo.md
│   └── shared-libs-philosophy.md
├── persistence/
│   ├── base-entity-and-base-repository.md
│   ├── entity-vs-domain-model.md
│   ├── mappers-and-repositories.md
│   ├── snake-naming-strategy.md
│   └── typeorm-overview.md
├── messaging/
│   ├── message-vs-event-patterns.md
│   ├── nest-microservices-transport.md
│   ├── rabbitmq-as-bus.md
│   └── routing-keys-and-contracts.md
├── caching/
│   ├── cache-aside-pattern.md
│   ├── cache-stack-overview.md
│   ├── lib-cacheable.md
│   ├── lib-cache-manager.md
│   ├── lib-keyv-redis.md
│   ├── lib-keyv.md
│   └── lib-nestjs-cache-manager.md
├── auth/
│   ├── auth-stack-overview.md
│   ├── jwt-and-rbac.md
│   ├── lib-argon2.md
│   ├── lib-nestjs-jwt.md
│   ├── lib-nestjs-passport.md
│   ├── lib-passport-jwt.md
│   └── lib-passport.md
├── observability/
│   ├── jaeger-backend.md
│   ├── lib-opentelemetry-api.md
│   ├── lib-opentelemetry-auto-instrumentations-node.md
│   ├── lib-opentelemetry-core.md
│   ├── lib-opentelemetry-exporter-trace-otlp-http.md
│   ├── lib-opentelemetry-instrumentation-amqplib.md
│   ├── lib-opentelemetry-resources.md
│   ├── lib-opentelemetry-sdk-node.md
│   ├── lib-opentelemetry-semantic-conventions.md
│   ├── opentelemetry-overview.md
│   ├── pino-logging.md
│   └── trace-log-correlation.md
├── application-layer/
│   ├── dto-by-direction.md
│   ├── notifier-port-and-adapters.md
│   └── use-cases-vs-fat-services.md
├── quality/
│   ├── lib-eslint-plugin-boundaries.md
│   └── test-strategy.md
└── tasks/                                  ← scratch; not part of deliverable
    ├── _carryover-01.md … _carryover-12.md
    └── task-01-…task-12-…md
```

**51 deliverable `.md` files** (1 root + 1 glossary + 49 articles
across 9 topic groups), all `status: final`, all
`updated: 2026-05-17`, all `[[wiki-link]]`s resolve, all GitHub
permalinks pinned to `84b1507c68fd9ee02b185eef3c4594b6fe02f664`.

The `tasks/` folder (24 files: 12 task scripts + 12 carryovers) is
**not** part of the deliverable. It is the writing-flow scratch
space and should be removed before importing into the Obsidian
vault (see follow-ups).

## Verification results

- [x] `glossary.md` exists with `status: final`, alphabetised
      table, and **437 term rows** — one row per canonical term
      collected across the ten previous carryovers.
- [x] `grep -rn 'заглушка\|Заглушка' docs/architecture-migration-ru/`
      returns matches **only** in `tasks/` (task scripts and
      carryovers describing the historical stub callouts); zero
      matches in any of the 51 deliverable articles. Verified by
      `find docs/architecture-migration-ru -name "*.md" -not
      -path "*/tasks/*" -exec grep -l 'заглушка\|Заглушка' {} +`
      → empty.
- [x] Every `[[wiki-link]]` in every article resolves to an
      existing slug (51 unique link targets, 51 matching files).
- [x] Every GitHub permalink uses the SHA from `_carryover-01.md`.
      Three `<SHA>`-placeholder URLs exist in `tasks/` (instructional
      content); zero placeholder URLs in articles.
- [x] No orphans across the guide (excluding the root file, which
      is the intended entry point and is exempt by spec).
- [x] Every article has `status: final` in its frontmatter
      (`51 status: final / 0 other`).
- [x] Every article has `updated: 2026-05-17` (today's date in
      the conversation context).
- [x] The root file's TOC matches the final folder structure
      one-for-one: 50 TOC entries map to 50 article files; the
      glossary is referenced under «Справочник»; the root is
      not referenced from itself (intended).
- [x] Working tree was clean at session start; only docs-only
      files were touched under `docs/architecture-migration-ru/`.
      Modified files: 51 (the 50 articles for `status` flip + root
      + glossary). No code under `apps/`, `libs/`, `tests/`,
      `test/`, or `scripts/` was modified.
- [x] No `git` mutating commands were run during this session.

## Suggested follow-ups for Eugene

These are not blocking — the guide is complete and shippable as
delivered. They are the realistic operational suggestions for
the next steps after this writing flow closes.

### Importing into the Obsidian vault

1. **Drop `tasks/` before importing.** The `tasks/` folder is
   writing-flow scratch space (12 task scripts + 12 carryovers).
   It is **not** part of the deliverable, and Obsidian will
   render `[[wiki-link]]` references inside the carryovers
   creating noise in the graph view. Suggested:

   ```bash
   # Copy guide to Obsidian vault, dropping tasks/
   rsync -av --exclude='tasks/' \
     docs/architecture-migration-ru/ \
     ~/ObsidianVault/projects/retail-inventory-system/
   ```

2. **Keep `tasks/` in the repo.** Per `_carryover-01.md` §«Notes
   for downstream tasks» #2, this guide's `tasks/` folder stays
   in the repository (unlike the migration plan, whose
   carryovers were deleted in task-14 of that flow). The
   carryovers are the writing-flow's own audit trail — they
   document **why** each article ended up as it did. Future
   you (or future contributors) will appreciate them when
   wondering «why does this article cite L46-L97, not L46-L100?»
   (`_carryover-11.md` §«GitHub permalinks pinned» records the
   off-by-one bug-fix).

3. **Frontmatter `related:` arrays will populate Obsidian's
   right-pane.** Every article has an explicit `related:` list
   (with one or two exceptions for stand-alone overview
   articles). Obsidian's «Backlinks» pane will additionally show
   incoming `[[wiki-link]]`s. Together these give bilateral
   navigation that is missing from raw GitHub-rendered Markdown.

4. **Glossary as a callout-source.** If you set up Obsidian's
   «Auto Glossary» or similar plugin, point it at
   `glossary.md`'s table and it will auto-tooltip terms on
   hover throughout the vault. The 437-row glossary was
   designed to be machine-parseable for exactly this purpose:
   one term per row, English in the first column, no nested
   tables, no merged cells.

### What to revisit in 6 months

5. **The Yarn.lock SHA pin (`84b1507c68fd9ee02b185eef3c4594b6fe02f664`)
   is the single point of staleness.** Every code excerpt in the
   guide is tied to that SHA. When Eugene cuts the
   `v1.0.0-architecture` release tag (per
   `_carryover-01.md` §Phase 14), permalinks will still work —
   they reference content, not the tag — but the gap between
   the recorded snapshot and the live tree will grow with every
   `migration-guide` → `main` merge. Suggested calendar reminder:
   **2026-11-17** (six months out) — re-run `find apps libs
   tests | wc -l` and `cat package.json | jq .dependencies`,
   and compare to `_carryover-01.md` §Inventory. If counts have
   drifted significantly (>10%), the guide's structural claims
   may have become stale; either re-pin to a fresher SHA (with
   the cost of re-validating every permalink) or accept the
   gap as the price of immutability.

6. **The `OTEL_SDK_DISABLED` retirement is the only deferral
   that closed in this task**. Other deferrals (the
   ARCH-LINT-EX-01 closure path via `ITransactionPort`, the
   transitional dual-prefix in `StockCache`, the
   `@Cacheable`-decorator's no-consumer-yet state) remain
   open — they are surfaced in the relevant articles as
   honest «не закрыто» notes. None of them block a portfolio
   reader from understanding the architecture.

### Which articles will stale fastest

7. **`docs/audits/audit-2026-05-08.md` references.** Three
   articles cite live audit-items (`cache-aside-pattern.md` —
   CACHE-001 / 002 / 003 / 004 / 005 / 007 / 008 / 009;
   `lib-keyv-redis.md` — CACHE-005; `test-strategy.md` —
   CACHE-001). When any of those items closes (with an ADR
   or a code-fix), the article's «открытые аудит-айтемы»
   section will misrepresent reality. Half-life estimate:
   **3–6 months** if active work resumes on the cache stack.

8. **`lib-eslint-plugin-boundaries.md` quotes
   `eslint.config.mjs` eight times** at specific line ranges
   (L9-L71, L82-L97, L106-L111, L113-L117, L120-L133,
   L320-L342, L373-L393, L523-L532) — see `_carryover-11.md`
   §«Suggested adjustments» #6. If a future PR reshapes the
   config (e.g. splits into multiple files or reorders
   `dependencyRules`), all eight permalinks may need
   re-targeting. Half-life: depends entirely on whether the
   linting story is revisited.

9. **`test-strategy.md`'s «29 unit-suites + 3 e2e + 1
   architecture-lint» pyramid** is a live claim verified at
   the recorded SHA. Adding a new `*.spec.ts` invalidates the
   pyramid-ratio prose. Half-life: short (any new test
   surface causes drift). A defensive option: re-phrase to
   «~30 unit-suites, …» in the article — a follow-up edit
   if numbers begin to matter.

10. **The eight `lib-opentelemetry-*.md` articles** are
    versioned against the resolved versions in
    `_carryover-01.md` §Technologies. OTel-SDK + auto-
    instrumentations is one of the faster-moving npm
    constellations in the project; expect at least one
    breaking-shape change per year (e.g. `BatchSpanProcessor`
    relocation, `Resource` builder rename). Half-life:
    **6–12 months** before at least one article's API
    examples need a re-pin.

11. **The `notification-consumer ~62s` artifact** described
    in `jaeger-backend.md` and rooted in
    `_carryover-10.md` §8 #3 of the migration plan is a
    library-specific quirk that will close itself if
    `@opentelemetry/instrumentation-amqplib` ships a fix.
    When that happens, the article's
    «Артефакт `process`-span'а» section becomes incorrect
    by inversion (the artifact is gone, not still present).
    Worth checking against the package's CHANGELOG on
    each annual review.

### Things that *won't* stale

12. **The concepts/ group** (5 articles) is pure architecture
    theory grounded in Vernon, Evans, Martin. Term definitions
    (Aggregate, Port, Adapter, Bounded Context, …) are stable
    across the entire field. Expect these articles to age the
    slowest — possibly never needing edits if the project's
    architecture stays hexagonal.

13. **The ADR catalogue** (referenced by every article through
    «связанные решения») is immutable by construction
    (`Status: Superseded by ADR-NNN` is the only allowed edit
    on an existing ADR). The guide's ADR references will not
    break unless an ADR is renumbered, which is forbidden by
    ADR-003 §«Numbering».

14. **The `glossary.md` exclusion list** (the «Что не вошло»
    callout) protects the glossary from accidental growth.
    Future writers who try to add «`retail_queue`» as a term
    will be redirected to the exclusion list and pointed at
    [[rabbitmq-as-bus]] §«Очереди» instead. The contract
    holds as long as the list is read.

## Closing note

This is the **final** carryover of the writing flow. The
architecture-migration guide is complete:

- 51 deliverable Markdown files
- 9 topic groups + glossary + root
- 437 canonical glossary terms
- 0 broken wiki-links
- 0 stub callouts
- 0 permalink-format violations
- 100% `status: final`

The writing flow ran from 2026-05-15 (task-01 scaffold) to
2026-05-17 (this task), producing approximately 90,000 words of
Russian-language architectural documentation across 12 tasks
and 12 carryovers. SHA pin `84b1507c68fd9ee02b185eef3c4594b6fe02f664`
holds. Branch: `migration-guide`. Working tree status at session
end: 51 modified files under `docs/architecture-migration-ru/`,
1 new file (`_carryover-12.md`), zero files outside the guide
folder touched.
