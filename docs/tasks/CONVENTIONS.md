# Fix-task conventions

> Shared rules that every fix-task prompt under `docs/tasks/` inherits.
> Read this once; each fix task references it by link rather than
> repeating the rules.

## 1. Self-containment

Each fix task runs in a **cleared Claude Code session**. The task file
must be sufficient on its own — every cross-reference (audit file, ADR,
code path) is spelled out in the task. The executing session does **not**
re-read the audit unless the task explicitly asks it to.

If the task references an ADR number that does not yet exist, leave a
placeholder (`docs/adr/<NNNN>-<slug>.md`) and the executing session picks
the next sequential number when it runs (see the current top number in
[`docs/adr/index.md`](../adr/index.md) — at the time of writing this
file the next free number is `021`).

## 2. No Git operations

Read-only git is fine — `git rev-parse`, `git log`, `git grep`,
`git status`, `git diff` all allowed. **Forbidden:** `add`, `commit`,
`push`, `branch`, `checkout`, `tag`, `merge`, `stash`, anything that
mutates `.git/`. Tasks deliver code changes via the file system; humans
review and commit them.

## 3. No sequential dependency by default

Fix tasks are independent. There is no `_carryover-NN.md` chain. Each
fix task ends with its own self-named `_fix-<slug>-summary.md` written
into `docs/tasks/`. The executing session does **not** assume any other
fix task has been done first.

If a fix task does have a real dependency on another, the dependent task
states it explicitly under a `## Prerequisites` heading: "this task
requires `<other task>` to be merged first; if the relevant code is
absent, mark BLOCKED in the summary and stop."

## 4. Verification gate

Every fix task ends with mandatory verification checks. Use yarn
(this repo's package manager — see [`package.json`](../../package.json)):

```
yarn install
yarn build
yarn lint
yarn test:unit
```

E2E is optional and called out per-task — running it requires
`yarn test:infra:reload` first, which is slow.

If any mandatory check fails and cannot be resolved within the task's
scope, the task marks itself BLOCKED in its `_fix-<slug>-summary.md` and
stops. **Do not** weaken a check, skip a test, or `--no-verify` a hook
to make the gate pass.

## 5. Documentation discipline

The migration's documentation discipline carries forward:

- **New architectural pattern** → write an ADR. Sequential numbering
  (next number lives in [`docs/adr/index.md`](../adr/index.md)). Nygard
  hybrid format per [ADR-003](../adr/003-record-architecture-decisions.md):
  Status, Context, Decision, Alternatives, Consequences. 3-digit padded
  filename.
- **Externally observable behavior change** → update the relevant
  section of [`README.md`](../../README.md).
- **Convention future sessions must follow** → update
  [`CLAUDE.md`](../../CLAUDE.md).
- **None of the above** → state explicitly "no documentation updates
  required" in the carryover summary, with one sentence on why.

## 6. Avoid scope creep

Each fix task fixes its named issues and nothing else. If the executing
session notices an adjacent problem (a stale comment, an unrelated bug,
a refactor opportunity), it records the finding in the
`_fix-<slug>-summary.md` for follow-up and **does not** fix it in the
same task.

## 7. Boundary respect

This repo's ESLint boundaries config (ADR-017) is the architectural
contract. Do not weaken a rule to make code pass — solve the underlying
import-direction problem instead. Inline `// eslint-disable-line
boundaries/dependencies` is allowed only when paired with an ADR §6
"Exceptions" entry; introducing a new one in a fix task requires
explicit user approval.
