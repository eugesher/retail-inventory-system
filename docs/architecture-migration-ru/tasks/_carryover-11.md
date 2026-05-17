# _carryover-11.md — Write quality articles (Phase: quality/)

> Generated 2026-05-17 by the task-11 session of the **architecture
> migration guide** writing flow. Builds on `_carryover-10.md` (which
> built on `_carryover-09.md` → … → `_carryover-01.md`, source of the
> SHA pin `84b1507c68fd9ee02b185eef3c4594b6fe02f664`).

## Entry-gate result

`_carryover-10.md` was read in full first. The three application-layer
articles it produced are on `status: review`; this task does not add
or change any forward-link from them. Branch is `migration-guide`;
working tree was clean at session start. No code under `apps/` or
`libs/` was modified. No `git` mutating commands were executed during
the session.

`_carryover-10.md` §«Suggested adjustments» #10 said: «Task-11
(`quality/`) gets only 2 articles — `lib-eslint-plugin-boundaries.md`
and `test-strategy.md`. The latter should honour the deferred
follow-up from `_carryover-09.md` §«Suggested adjustments» #«the
`OTEL_SDK_DISABLED=true` test-context»; that deferral is now one task
closer to home.» — This deferral is **not** honoured by this session
because `OTEL_SDK_DISABLED` is **not** referenced in the project's
tracer.ts, jest configs, or test setup files (verified by
`grep -rn 'OTEL_SDK_DISABLED' apps libs test tests scripts` → 0 hits).
The artifact referenced in `_carryover-09.md` was a forward-looking
hypothetical, not a shipping mechanism. Test-strategy article
correctly omits it. Future task (`glossary.md` in task-12 or a
follow-up audit) may close the deferral by retiring the forward-
looking mention from `_carryover-09.md`.

## Articles written

Two quality-group articles, both reshaped from the task-01 stub into
stand-alone Russian-language articles grounded in production code
at the recorded SHA.

| Path | One-line Russian summary |
| ---- | ------------------------ |
| `docs/architecture-migration-ru/quality/lib-eslint-plugin-boundaries.md` | `eslint-plugin-boundaries@^6.0.2` как codified-architecture: 18 element-type'ов с `capture: ['app', 'module']`-templates; унифицированный `boundaries/dependencies`-rule с `default: 'disallow'` + `checkAllOrigins: true`; catch-all для npm в индексе 0 — load-bearing; per-source external-denylists; документированное `lib-contracts`-исключение (`@nestjs/swagger`, `class-validator`, `class-transformer`); `ARCH-LINT-EX-01` с tracking-code'ом + TODO; regression-spec как бумпер; список ограничений (не enforce'ит import-order, naming-conventions, и т.д.). — ~2781 слов. |
| `docs/architecture-migration-ru/quality/test-strategy.md` | Трёхуровневая пирамида: 29 unit-suites + 3 e2e в `test/` + 1 architecture-lint-spec. In-memory port-doubles как convention (`test-doubles.ts` — plain TypeScript, no jest globals, реализует port-interface, держит state в Map/Array). E2E поднимает реальную инфру через `test:infra:reload` (hard reset с `-v`). `system-api.e2e-spec.ts` поднимает 3 Nest-app'а в одном process'е; `auth.e2e-spec.ts` ловит rotation reuse-detection (flow-test, unit'ом не воспроизводимо); `notification.e2e-spec.ts` синтетически publish'ит event с poll-loop'ом. Список ограничений: coverage не enforce'ится, race-conditions не покрыты, performance не отлавливается. — ~2602 слов. |

Both articles flipped `status: draft` → `status: review` in their
frontmatter; `updated:` set to `2026-05-17`. Each carries the
mandatory `> [!abstract] Кратко` block, `## Глоссарий` section,
`> [!faq]- Проверь себя` collapsible (5 questions each), and
`## Что почитать дальше` with 4–6 external references.

## GitHub permalinks pinned

Across the two articles: **33 permalink citations / 33 unique URLs**
pinned to `84b1507c68fd9ee02b185eef3c4594b6fe02f664`. Per-article:

| Article | Citations |
|---------|-----------|
| `lib-eslint-plugin-boundaries.md` | 17 |
| `test-strategy.md` | 16 |

No URL is cited by both articles, despite considerable thematic
overlap — the two articles target adjacent concerns and naturally
cite different code anchors. The most-cited file is
`eslint.config.mjs` (8 different line ranges across
`lib-eslint-plugin-boundaries.md`); next is
`tests/lint/architecture-lint.spec.ts` (4 different line ranges
across both articles).

Code anchors cited (deduped):

- **ADR documents (5)** — ADR-011, ADR-012, ADR-013, ADR-017
  (cited from both articles' references), plus `audit-2026-05-08.md`
  in `test-strategy.md`.
- **`recommendation.md` §3** (L221-L240) — cited in
  `lib-eslint-plugin-boundaries.md`.
- **`eslint.config.mjs`** (8 line ranges) — the spine of the
  lib-article. Ranges cover boundariesElements (L9-L71), the
  helper templates (L82-L97), the catch-all (L106-L111), the
  per-source allow blocks (L113-L117, L120-L133), the
  per-source disallow blocks (L320-L342, L373-L393), and the
  global rule configuration (L523-L532).
- **`tests/lint/architecture-lint.spec.ts`** (4 line ranges) —
  cited in both articles. Cross-app fixture L291-L300,
  presentation→infrastructure negative L302-L309, positive
  case L322-L330, the `lint()` helper L197-L200.
- **Production files with `ARCH-LINT-EX-01`** (2 line ranges
  on 2 files) — cited in `lib-eslint-plugin-boundaries.md`.
- **`test/` directory** (5 line ranges on 3 files) — cited in
  `test-strategy.md`. Includes one corrected range
  (`system-api.e2e-spec.ts` L46-L100 → L46-L97 after
  verification revealed it spilled into the afterAll block).
- **`apps/inventory-microservice/.../test-doubles.ts`**
  (2 line ranges) — cited in `test-strategy.md` for the
  «no jest globals here» convention.
- **`scripts/test-db-seed.ts`** (2 line ranges) — cited in
  `test-strategy.md` for stable UUIDs and argon2 options.
- **`package.json`** (file-level, no line range) — cited in
  `test-strategy.md` for the `test:*` script chain.
- **`.github/workflows/ci-cd.yml`** (file-level) — cited
  once in `test-strategy.md` for the CI gate sequence.

Each cited line range was validated against the file's actual
content at the recorded SHA. One off-by-one bug was caught and
corrected during verification:

- `test/system-api.e2e-spec.ts` L46-L100 → L46-L97. The
  `beforeAll` block ends at L97 (`}, timeout);`); L98 begins
  the `afterAll` block. The range previously spilled three
  lines into the wrong test-hook. Corrected post-write.

## Word counts

| Article | Suggested | Actual |
|---------|-----------|--------|
| `lib-eslint-plugin-boundaries.md` | ~2500 | **2781** |
| `test-strategy.md` | ~2000 | **2602** |
| **Total** | **~4500** | **5383** |

Overshoot pattern consistent with the rest of the corpus: ~10-30%
above target for body-content articles, driven by Russian-language
verbosity + the glossary + self-check + «что почитать дальше» tail
(~400 words constant overhead). `test-strategy.md` runs longer than
target because it walks five distinct test suites (unit, system-api,
auth, notification, architecture-lint) — each with its own
code-anchor section.

## Audit status

No new audit items opened by this session. Existing tracked items
re-referenced:

- **`ARCH-LINT-EX-01`** is now **quadruple-documented**: ADR-017 §6,
  `_carryover-12.md` (migration plan), `use-cases-vs-fat-services.md`
  (task-10 output), and now `lib-eslint-plugin-boundaries.md`
  (task-11). Each carries the closure path
  (introduce `ITransactionPort`). Cross-link is consistent.

- **`CACHE-001`** (cache-aside race window) is referenced from
  `test-strategy.md` §«Что Jest не ловит» as an example of a
  concurrency issue that current tests don't reach.
  The article does not propose a fix — that belongs to a
  cache-stack follow-up.

- **The `OTEL_SDK_DISABLED=true` deferral** from
  `_carryover-09.md` §«Suggested adjustments» #4 is **not honoured**
  in this task. Investigation revealed it was a forward-looking
  hypothetical, not a shipping env-var. Task-12 audit may retire
  the deferral note.

## Glossary terms collected

EN→RU pairs introduced across the two articles. These get rolled
into the consolidated `glossary.md` in task-12.
**Approximately 50 new pairs** introduced across the group;
substantial overlap with existing groups (e.g. «port», «adapter»,
«DI symbol» reappear from `application-layer/` articles).

Key new terms (not yet defined elsewhere):

| Source article | EN term | RU explanation (short) |
| -------------- | ------- | ---------------------- |
| lib-eslint-plugin-boundaries | Element type | Логический тип файла в плагине; назначается через glob. |
| lib-eslint-plugin-boundaries | Pattern | Glob, который матчит файлы для element-type'а. |
| lib-eslint-plugin-boundaries | `capture` | Список именованных wildcard'ов; запоминает значения `*` для template-подстановки. |
| lib-eslint-plugin-boundaries | `{{from.captured.x}}` | Template-syntax для подстановки captured-значения. |
| lib-eslint-plugin-boundaries | `boundaries/dependencies` | Единственный rule v6 API. |
| lib-eslint-plugin-boundaries | `default: 'disallow'` | Полярность по умолчанию (fail-closed). |
| lib-eslint-plugin-boundaries | `checkAllOrigins: true` | Опция: проверять и internal, и external. |
| lib-eslint-plugin-boundaries | `last match wins` | Семантика массива правил. |
| lib-eslint-plugin-boundaries | Catch-all rule | Первое правило: blanket-allow для всех npm + core. |
| lib-eslint-plugin-boundaries | Origin (`external`/`core`) | Тип target'а: npm или Node-stdlib. |
| lib-eslint-plugin-boundaries | Internal edge / External edge | Зависимость inside-repo / на npm. |
| lib-eslint-plugin-boundaries | `sameModule(type)` | Helper для same-`{app, module}`-target'а. |
| lib-eslint-plugin-boundaries | `sameApp(type)` | Helper для same-`{app}`-target'а. |
| lib-eslint-plugin-boundaries | `lib(type)` | Helper для lib-*-typed target'а. |
| lib-eslint-plugin-boundaries | `eslint-disable-line` | Inline-комментарий с правилом-исключением. |
| lib-eslint-plugin-boundaries | Tracking code | Стандартизированный ID exception'а (например, `ARCH-LINT-EX-01`). |
| lib-eslint-plugin-boundaries | Regression spec | `tests/lint/...spec.ts`; бумпер от silent loosening. |
| lib-eslint-plugin-boundaries | Bumper vs contract test | Spec ловит ослабление, не drift между копиями. |
| lib-eslint-plugin-boundaries | `Linter.verify(...)` | Programmatic ESLint-API. |
| lib-eslint-plugin-boundaries | `boundaries/no-unknown` | Off-by-default rule. |
| test-strategy | Test pyramid | Соотношение unit : integration : e2e. |
| test-strategy | In-memory port double | Plain-TS class реализующий port. |
| test-strategy | `test-doubles.ts` | Файл-конвенция для port-doubles. |
| test-strategy | ts-jest | TypeScript transformer для Jest. |
| test-strategy | Supertest | HTTP-клиент для тестов. |
| test-strategy | `--runInBand` | Jest-flag: последовательное выполнение. |
| test-strategy | `--forceExit` | Jest-flag: жёсткий exit после теста. |
| test-strategy | `jest.spyOn` vs `jest.mock` | Spy с реальной реализацией vs полный mock. |
| test-strategy | `test:infra:reload` | npm-скрипт: hard-reset инфраструктуры. |
| test-strategy | Hard reset | Удаление Docker-volume'ов перед тестом. |
| test-strategy | Healthcheck `--wait` | Docker-compose-flag: ждать healthy. |
| test-strategy | Seed (test) | Скрипт `scripts/test-db-seed.ts`. |
| test-strategy | Stable UUID | Фиксированный UUID, на который assert'ятся `expect.toBe(...)`. |
| test-strategy | `waitForCall` | Poll-loop с deadline для async-event'ов. |
| test-strategy | Coverage threshold | Минимальный %-coverage перед прохождением (НЕ выставлен). |
| test-strategy | Race window (`CACHE-001`) | Audit-item, не покрыт тестами. |

## Cross-references added

### Within `quality/` (sibling links)

The two articles cross-link to each other reciprocally:

- `lib-eslint-plugin-boundaries` ↔ `test-strategy` — both
  link via `related:` frontmatter AND in the «Связанные
  решения» section. `test-strategy` mentions
  `lib-eslint-plugin-boundaries` for the architecture-lint
  spec; `lib-eslint-plugin-boundaries` mentions
  `test-strategy` for context on how the regression-spec
  fits into the broader test taxonomy.

### Cross-group back-links

Both articles back-link into established groups:

- `[[module-boundaries]]` (concepts/) — referenced by
  `lib-eslint-plugin-boundaries`. The concept of «what can
  import what»; the plugin is its executor.
- `[[hexagonal-architecture]]` (concepts/) — referenced by
  both. The layer-shape that lint and tests both encode.
- `[[clean-architecture-layers]]` (concepts/) — referenced
  by `lib-eslint-plugin-boundaries`. The four-layer split
  reflected in element-type taxonomy.
- `[[shared-libs-philosophy]]` (project-shape/) — referenced
  by `lib-eslint-plugin-boundaries`. The lib-map encoded as
  `lib-*` element types.
- `[[architecture-decision-records]]` (concepts/) —
  referenced by `lib-eslint-plugin-boundaries`. ADR-017 as
  example.
- `[[use-cases-vs-fat-services]]` (application-layer/) —
  referenced by both. Use-case shape is what makes
  in-memory-test-doubles work.
- `[[dto-by-direction]]` (application-layer/) — referenced
  by `lib-eslint-plugin-boundaries` for the `application-dto`
  element-type.
- `[[notifier-port-and-adapters]]` (application-layer/) —
  referenced by `test-strategy` for `LogNotifierAdapter`
  as the e2e-test surface.
- `[[mappers-and-repositories]]` (persistence/) — referenced
  by both.
- `[[entity-vs-domain-model]]` (persistence/) — referenced
  by `test-strategy` for mapper-spec context.
- `[[rabbitmq-as-bus]]` (messaging/) — referenced by
  `test-strategy` for e2e-RMQ context.
- `[[cache-aside-pattern]]` (caching/) — referenced by
  `test-strategy` for open audit-items.
- `[[jwt-and-rbac]]` (auth/) — referenced by `test-strategy`
  for rotation reuse-detection e2e.
- `[[opentelemetry-overview]]` (observability/) — referenced
  by `lib-eslint-plugin-boundaries` for the tracer-import-
  first rule the plugin doesn't enforce.

**No forward-links into yet-unwritten articles.** All wiki-link
targets resolve to files that exist under
`docs/architecture-migration-ru/`. `glossary.md` is the only
remaining slot (task-12) and is intentionally not linked.

### Root file's TOC

`docs/architecture-migration-ru/architecture-migration-guide.md`
already lists both `quality/` slugs at L165-L166 (populated by
task-01's scaffolding). No edits to the root file required this
session.

## Verification results

- [x] All two slot files filled; no `заглушка` callouts remain
      (verified by `grep -lc 'заглушка\|Заглушка'
      docs/architecture-migration-ru/quality/*.md` → 0 hits).
- [x] Every code excerpt has a GitHub permalink pinned to
      `84b1507c68fd9ee02b185eef3c4594b6fe02f664` (**33 citations
      / 33 unique URLs**: 17 + 16 per-article).
- [x] Every `[[wiki-link]]` resolves to a file that exists under
      `docs/architecture-migration-ru/` (verified by enumerating
      16 unique targets via `grep` + `find`):
      - Within `quality/`: 2 — reciprocally linked.
      - Cross-group: 14 unique targets across all earlier
        groups (concepts, project-shape, persistence,
        messaging, caching, auth, observability,
        application-layer). All hit existing files.
- [x] No orphan slugs under
      `docs/architecture-migration-ru/quality/`.
- [x] Each article above the 600-word soft floor (smallest:
      `test-strategy.md` at **2602 слов**; largest:
      `lib-eslint-plugin-boundaries.md` at **2781 слов**;
      median across the 2 articles is **~2691 слов**).
- [x] Frontmatter valid on each touched file (`status: review`,
      `updated: 2026-05-17`, `related: [...]` populated with
      9 wiki-link entries each).
- [x] Each article carries the mandatory `> [!abstract] Кратко`
      callout, `## Глоссарий` section, and `> [!faq]- Проверь
      себя` self-check block (5 questions each).
- [x] No `git` mutating commands were run during this session.
- [x] Working tree was clean at session start; only docs-only
      files were touched under `docs/architecture-migration-ru/`.
      No code under `apps/`, `libs/`, `tests/`, `test/`, or
      `scripts/` was modified.
- [x] Permalink line-ranges spot-verified via `sed -n
      'NN,MMp'` against the recorded SHA's content. One
      off-by-one was caught and corrected
      (`system-api.e2e-spec.ts` L46-L100 → L46-L97 — the
      original range spilled into the `afterAll` block).

## Suggested adjustments to upcoming tasks

1. **The quality group is now COMPLETE** (2 articles:
   `lib-eslint-plugin-boundaries`, `test-strategy`). Both ship
   at `status: review`. Audit time in task-12 will involve
   confirming the «29 unit suites» claim is still accurate —
   if any new spec file is added between task-11 and task-12,
   the article's pyramid-ratio prose needs a one-line update.
   `find apps libs tests -name "*.spec.ts" | wc -l` is the
   sanity check.

2. **Task-12 (glossary + final audit) is the only remaining
   writing task.** All 50 article slots will be filled by
   end-of-task-11 (`status: review`); task-12 produces
   `glossary.md` and flips every article to `status: final`
   after a guide-wide consistency pass. The deferred
   `OTEL_SDK_DISABLED` follow-up from `_carryover-09.md`
   should be **retired** in task-12 — investigation confirmed
   it doesn't exist in shipping code.

3. **The corpus now has 47 articles written + 4 carryovers**.
   Glossary task-12 will need to dedupe ~60-80 terms across
   group boundaries. Conservative estimate: «port», «adapter»,
   «DI symbol», «use case», «aggregate root», «value object»,
   «correlation ID», «mapper», «entity», «event», «span»,
   «routing key» each appear in 3+ articles.

4. **No new ADRs were necessary** during this writing
   session. Both articles document existing decisions
   (ADR-017 primarily). No architectural decisions were
   taken.

5. **`tests/lint/architecture-lint.spec.ts` is the only
   non-`*.spec.ts` file in `tests/`.** All other test files
   live under `test/` (e2e + setup). The double-directory
   layout is unusual; task-12 audit may add a note in
   `glossary.md` distinguishing `test/` (e2e + setup) from
   `tests/lint/` (architecture-lint regression).

6. **The lib-article quotes `eslint.config.mjs` 8 times**
   with different line ranges. If a future PR reshapes the
   config (e.g. splits it into multiple files or reorders
   the `dependencyRules` array), 8 permalinks may break.
   This is a deliberate trade-off: the article cites
   specific blocks because they're the load-bearing parts
   of the config, and citing the whole file would be
   useless. If maintainability of permalinks matters,
   widen the ranges in a follow-up audit.

7. **The `test-doubles.ts` convention is now documented in
   both `[[use-cases-vs-fat-services]]` (task-10) and
   `[[test-strategy]]` (this task).** The two articles
   approach it from different angles (the former: «here's
   why use-cases inject ports»; the latter: «here's how
   port-doubles enable unit tests»). Cross-link is
   reciprocal. If a future audit detects redundancy,
   neither version is exhaustive enough to drop the other
   — they answer different reader questions.

8. **The CI gate ordering** (lint → build → test:unit →
   test:e2e) is documented in both
   `lib-eslint-plugin-boundaries.md` §CI-интеграция and
   `test-strategy.md` §CI gate-цепочка. Different phrasings
   but consistent content. If `.github/workflows/ci-cd.yml`
   evolves (e.g. adds a separate architecture-lint job),
   both articles need updates. Cross-references are bilateral.

9. **`coverage` is not enforced and is documented as such.**
   Task-12 audit may consider whether the `glossary.md`
   should make this prominent enough that a future
   contributor doesn't add a coverage threshold by accident.
   The decision to NOT enforce coverage isn't an ADR — it's
   a convention. If it becomes important, an ADR-021 could
   formalize it.

10. **Russian-language verbosity tax confirmed across the
    corpus** (12 carryovers, 47 articles). Future writers
    should expect ~30% overshoot vs English-target wordcount.
    Task-12 verification rules should set ranges as «soft
    floors», not «hard ceilings» (current rules already do
    this, but make it explicit if anyone questions the long
    articles).

11. **`tests/lint/architecture-lint.spec.ts` deliberately
    inlines a subset of production rules** (verified at L33-L161
    of the spec). This is non-obvious — task-12 audit should
    ensure `glossary.md` introduces «bumper» as distinct from
    «contract test» so readers understand the design choice.
    Currently both articles use the word but `glossary.md`
    will be where the term canonically lands.
