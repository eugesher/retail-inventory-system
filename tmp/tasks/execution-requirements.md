# Execution requirements for tasks under `tmp/tasks/`

> Read this in full before writing any code. Every task file generated from an
> epic links to this document in its **Required reading** — these are the rules
> that govern the *execution* of a single task. The rules for *decomposing* an
> epic into tasks live in `tmp/epic-decomposition-template.md`; you do not need
> them to execute a task.

## 0. The execution model

- **One task = one clean Claude Code session.** You start cold. You inherit no
  memory from the session that ran the previous task.
- State flows forward only through two channels: (a) what the previous tasks
  committed to the repository, and (b) the `carryover-NN.md` notes in this
  task's subfolder. **The carryover docs are your memory of the prior tasks** —
  read them.
- Tasks are **sequential and ordered**. Do not assume any later task has run;
  do not depend on work a future task will do.

## 1. Required reading (every task, in this order)

1. **This file** (`tmp/tasks/execution-requirements.md`).
2. **All preceding carryover docs** — `carryover-01.md … carryover-(N-1).md` in
   this task's subfolder, in order. They state the on-disk entry state you are
   building on.
3. **`tmp/adr-summary.md`**, then open and follow the individual
   `docs/adr/NNN-*.md` documents relevant to this task. The digest summarizes
   the rules; the originals carry the rationale and edge cases. **Decomposed
   tasks must not violate any accepted ADR.**

You will also read the task file itself, and may consult the epic it was
derived from for context — but the epic and everything else under `tmp/` is
orchestration scratch. **Never cite anything under `tmp/` in a deliverable**
(see §6).

## 2. Latitude: build as if from scratch

No production environment exists yet — nothing has been deployed, there is no
data to preserve, and there is no external consumer to keep stable. Therefore:

- You may **modify or delete** any business code, domain entity, entity field,
  database table, database column, or migration content.
- Optimize for the **cleanest possible final state**, not for backward
  compatibility with anything an earlier task or commit established.

## 3. Conflict resolution = deletion, never renaming

Every epic front-loads a cleanup / conflict-resolution task. When you are
executing it (or hit a naming/state conflict in any task):

- **Remove** obsolete legacy entities, fields, tables, columns, and business
  code outright.
- **Do NOT rename** to `legacy`, `old`, `deprecated`, `_v1`, `_bak`, `_new`, or
  any similar suffix. A rename leaves two of everything and defeats the cleanup.
- Update or **delete every reference** to the removed thing in the same task.
  The start-from-scratch latitude (§2) lets you delete a now-dangling reference
  rather than preserve it.
- Land schema removals as a real migration (`yarn migration:create`) with a
  working `up`/`down`. `synchronize` stays off (ADR-019).

## 4. Document what was done & why, in `docs/implementation/`

- Write the implementation doc(s) the epic names. The epic frontmatter's
  `docs_subfolder` gives the directory; its **Documentation Deliverables**
  section gives the file list. Path shape: `<docs_subfolder>/NN-topic-slug.md`.
- Explain the **why** — rationale, trade-offs, alternatives rejected, which
  ADRs are honored and how — not merely a list of files changed.
- Write for a reader who has **never seen the planning materials** and has only
  the repository. Cross-link sibling docs and `docs/adr/NNN-*.md` by relative
  path.

## 5. Keep `README.md` and `CLAUDE.md` current

These are part of the deliverable. A task is not done until they reflect it.

- **`README.md`** — services table, system diagram, route lists, seed-data
  tables, environment variables: update whatever the task changed.
- **`CLAUDE.md`** — the architecture app tree, per-module/service sections,
  message-pattern list, shared-library notes: update whatever the task changed.

## 6. Self-containment (the hard rule)

**Treat `tmp/` as if it does not exist for everything outside `tmp/`.**

- No file under `docs/`, `apps/`, `libs/`, `http/`, `scripts/`, `spec/`,
  `migrations/`, `README.md`, or `CLAUDE.md` may reference any path under
  `tmp/`.
- The words **"epic"** and **"task"** — used as names for this planning
  process — must not appear in those files or in code comments. Organize
  implementation docs by number + topic slug (e.g.
  `03-product-and-variant-persistence.md`), never by an epic/task breadcrumb.
- **Forbidden anti-pattern** (a real leak that has happened): an implementation
  doc opening with a header line like `> Epic-02 · Task-01 · Foundation-only.`
  Replace it with a self-contained topic intro that explains the change on its
  own terms.
- References to documents under `tmp/` are allowed **only inside `tmp/`**.
- **Gate before finishing** — run and investigate every hit:

  ```bash
  grep -rniE 'tmp/|\bepic\b|\btask\b' \
    docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md
  ```

  The expected result is no orchestration references. Remove any pre-existing
  leak you encounter as part of your documentation pass. (A hit on a genuine
  domain term unrelated to this planning workflow is acceptable; a hit that
  refers to the planning workflow is not.)

## 7. Carryover documents (transition between clean sessions)

- At the **end** of task NN, write `<this-task-subfolder>/carryover-NN.md`
  (zero-padded to match the task number — `carryover-01.md`, `carryover-02.md`,
  …).
- This is the **only** place a transition marker may live. Never leave
  "next task", "TODO for the following step", or similar handoff notes in
  source code, docs, `README.md`, or `CLAUDE.md` — those would violate §6.
- Capture, at minimum:
  - **Entry state for the next task** — what is now on disk and in the schema.
  - **Files added / modified / deleted** — a concise list.
  - **Key decisions & deviations** — anything the next session must respect
    (names chosen, ADR numbers allocated, ports/symbols introduced).
  - **Known gaps / deferrals** — stated explicitly, naming the later task that
    owns each.
  - **How to verify** — the exact commands that prove this task's exit criteria
    (boot, migrate, lint, unit, e2e, the relevant `.http` calls).
- The next session reads `carryover-01.md … carryover-NN.md` in order before
  doing anything.

## 8. Tests (detailed unit + e2e)

- **Unit** — spec siblings next to the domain/use-case code (`*.spec.ts`), run
  by `yarn test:unit`. Cover the happy path **and** each invariant/rejection,
  emitted events, and (for guarded flows) permission gating, as the epic's
  **Test Strategy** enumerates.
- **E2E** — through the API gateway under `test/*.e2e-spec.ts`, run by
  `yarn test:e2e` (reloads infra, migrates, seeds, then tests) or
  `yarn test:e2e:run` against already-running infra.
- Extend `scripts/test-db-seed.ts` when the task needs new seed data; keep the
  seed **idempotent** (re-running it must not error or duplicate rows).

## 9. Kulala HTTP files for every new gateway endpoint

Every new or changed endpoint in `apps/api-gateway` must be described in an
`http/*.http` file (one file per gateway area, e.g. `http/catalog.http`).
Match the conventions of the existing files:

- `@baseUrl = {{ENV_BASE_URL}}` at the top; environment values in
  `http/http-client.env.json`.
- `###` separators between requests; a `# @name <id>` line per request.
- Header comments citing the **controller path** and the params/query shape.
- A `# Prereqs:` block describing the seeded login flow and capturing the
  bearer token into an `@accessToken` variable for the protected calls.
- No `tmp/`, "epic", or "task" references in `.http` files (§6 applies here too).

## 10. Definition of done (per task)

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes (the new specs are green).
- [ ] `yarn test:e2e` passes on a fresh `migration:run` + seed.
- [ ] Any new migration applies and reverts cleanly; the seed is idempotent.
- [ ] The implementation doc(s) in `<docs_subfolder>/` are written, explaining
      what and why.
- [ ] `README.md` and `CLAUDE.md` reflect the change.
- [ ] Every new gateway endpoint is in an `http/*.http` file.
- [ ] `carryover-NN.md` is written in this task's subfolder.
- [ ] The self-containment grep (§6) is clean.
- [ ] The task file's own **Exit criteria** are all satisfied.
