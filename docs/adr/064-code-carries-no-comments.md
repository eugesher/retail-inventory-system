# ADR-064: Code carries no comments — the knowledge lives in documents a reader can check

- **Date**: 2026-09-25
- **Status**: Accepted

---

## Context

At `aca476e`, before the cleanup this ADR closes, **1 095 of the 1 399** TypeScript and JavaScript
files carried comments: **21 081 lines** in 4 609 blocks. About 400 more lines sat in SQL seeds,
the Dockerfile, the compose and CI YAML, `.env.example` and `.gitignore`, and 1 942 prose lines in
the Kulala request collections under `http/`.

**Nothing checked any of it.** A reviewer reads the diff; the comment three lines above the diff is
not in it. The compiler reads the code. So a comment is believed for exactly as long as nobody
compares it with the code, and this repository has already paid for that more than once:

- **ADR-060 / RIS-277.** The doc comment on `AggregateRoot`, the base class of every aggregate, made
  three claims — repository adapters drain events, through an outbox, exactly once. All three were
  false, and [ADR-060](060-what-drains-a-domain-event.md) had to be written to say so.
- **RIS-274.** The comment on the CI `lint` job said `eslint-plugin-boundaries` was installed but
  not wired, four months after it had become the architecture gate — to the one reader who arrives
  there because a `boundaries/*` rule just failed.
- **RIS-279.** The same failure in prose that sits beside a rule: a `no-restricted-imports` message
  named an e2e spec that had been deleted three months earlier, in two places at once.
- **ADR-049** found three port methods whose comments vouched for callers that did not exist, and
  called it "three ADRs running". [ADR-053](053-how-a-transition-window-closes.md) named the general
  shape: _a comment that reads plausibly is a comment nobody rereads_.

### What moving every comment found

The cleanup (RIS-289 to RIS-303) read every comment, sorted it, and checked each one that said
something the code does not before moving it anywhere. Roughly, by block:

| What the comment was                                       |  Blocks |
| ---------------------------------------------------------- | ------: |
| A paraphrase of the code next to it, or noise              | ≈ 2 370 |
| Already written in an ADR, `README.md` or another document | ≈ 1 570 |
| Knowledge found nowhere else, and true                     |   ≈ 570 |
| History: how the code got here                             |   ≈ 285 |
| **Contradicted by the code**                               | **110** |

**Of the ≈ 680 comments that said something the code and the documents did not, about one in six
was false.** A sample:

| Comment                                                                              | What the code does                                                                                                                                          |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CancelAllocationUseCase`: "a fully-tested reserved surface with no in-repo caller"  | Retail calls it from Cancel Order, Cancel Line and Place Order's compensation                                                                               |
| `FulfillmentEntity.version`: "the OCC token, per shipment"                           | The version is bumped on every save and never compared ([`retail-orders.md`](../reference/retail-orders.md#reads-locks-and-versions))                       |
| event store `main.ts`: "the consumer never rethrows, so a message is always acked"   | Nothing acks; every channel close re-delivers the queue's whole history ([`event-store.md`](../reference/event-store.md#what-the-queues-do-with-a-message)) |
| event store query use cases: "every filter names an INDEXED column"                  | Three filter shapes are a full scan plus a filesort under `EXPLAIN` ([`event-store.md`](../reference/event-store.md#reads))                                 |
| `IdempotencyStoreTypeormRepository`: "`finalize` UPDATEs — but only a `pending` row" | The `UPDATE` has no condition on the row's state ([`retail-orders.md`](../reference/retail-orders.md#the-idempotency-store))                                |

**A false comment does not stay a comment.** The belief that a throw from an event handler makes
the broker redeliver sat in at least a dozen comments across three services, then in `README.md`
§4, and in ADR-011 §7. The fulfillment "OCC token" reached `README.md` §5 and ADR-036 §2. The
cleanup corrected `README.md` in each case; ADR-003 allows an accepted ADR nothing beyond a `Status`
change and a pointer, so those sentences still stand there.

### What a comment was actually for

The true, unique ≈ 570 were real knowledge: an invariant, the order of two writes around a commit,
why a race is safe, a unit or a time zone, a failure mode. The cleanup wrote each one into
[`docs/reference/`](../reference/README.md), one file per area, anchored by path and symbol, after
checking it against the code. The reference folder did not exist before this work. It now holds
fifteen area files.

## Decision

> **Code carries no comments.** What a comment would have said goes where it can be found, linked
> and reviewed as a document.

### 1. Where the knowledge lives

| Knowledge                                                             | Home                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Why it was decided that way, and what was rejected                    | an ADR under `docs/adr/`                                           |
| How it behaves now, when the code alone does not make it plain        | `docs/reference/<area>.md`, each claim anchored by path and symbol |
| Routes, configuration, seed data, background jobs, the error contract | `README.md`                                                        |
| Which error code maps to which HTTP status                            | the module's `*RpcExceptionFilter`                                 |
| What a scenario proves                                                | the `describe` / `it` title                                        |
| What a thing is                                                       | its name and its type                                              |

A pull request that changes behaviour described in `docs/reference/` updates or deletes the entry in
the same change. Review asks for it, the same way it asks for a test.

### 2. The closed list of exceptions: functional directives

A directive is read by a tool, not by a person, and removing it changes what the tool does. These
stay, each kept whole, including a `-- reason` tail:

- `eslint-disable…` / `eslint-enable`, and `/* global … */`;
- `@ts-expect-error`, `@ts-ignore`, `@ts-nocheck`, `@ts-check`;
- `prettier-ignore`, `istanbul ignore`, `c8 ignore`;
- webpack magic comments (`webpackChunkName`, `webpackIgnore`, …);
- `/// <reference … />`, and a shebang on a file's first line;
- JSDoc type annotations (`@type`, `@typedef`, `@satisfies`) in `.js` / `.mjs` / `.cjs` files only,
  where they are the type syntax;
- in a `.http` request collection, the `###` separator and the `# @…` / `// @…` directives.

**A directive is never the way to make the check pass.** Adding an `eslint-disable` to silence a
rule is its own decision, argued on its own merits in review.

### 3. The check: `spec/no-code-comments.spec.ts`

The rule ships with its enforcement, for the reason ADR-053 gives: a rule with no check is a wish.
The spec runs in `yarn test:unit` and scans every file `git ls-files --cached --others
--exclude-standard` lists, except the vendored `.yarn/`:

| Files                                                                                                                    | What it checks                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`                                                             | Every comment the TypeScript parser attaches to a token, line or block, own-line or trailing, unless it is a directive |
| `.sql`                                                                                                                   | `--`, `#` and `/* */` outside a quoted string or identifier                                                            |
| `Dockerfile*`, `.yml`, `.yaml`, `.sh`, `.env`, `.env.example`, `.toml`, `.py`, `.gitignore`, `.dockerignore`, `.husky/*` | A line whose first non-blank character is `#`, except a shebang on line 1                                              |
| `.http`                                                                                                                  | A line starting with `#` or `//`, except `###` alone and `# @…` / `// @…`                                              |

Each red line names `file:line`. **When it is red, delete the comment.** If it said something true
that the code does not, write that in `docs/reference/` or an ADR. Never add an allowlist, and never
add a directive to hide it.

The spec also runs its detector over in-memory fixtures first, so a detector that stopped finding
comments turns it red instead of passing.

### 4. What the check does not see, and why

The rule still covers these; review is what enforces it there.

- **A trailing `#` comment in YAML, shell, a Dockerfile or `.env`.** Telling `key: a # b` from a `#`
  inside a value needs each format's own parser, quoting rules and all. A whole-line `#` has no such
  ambiguity, apart from a line inside a YAML block scalar, a shell heredoc or an `.http` request
  body, where it is data.
- **A Python docstring** in `http/posting/*/scripts.py`. It is a string expression, found only by a
  Python parser.
- **SQL inside a TypeScript string**, such as a migration's DDL. The `--` would have to be told apart
  from the rest of the literal.
- **Markdown**, which is documentation, and JSON, which has no comment syntax.

Strings that describe the code — an `@ApiProperty({ description })`, a Posting `description:` field,
a lint rule's `message` — are data, not comments, and are not in scope. RIS-279 shows they drift
too.

## Alternatives Considered

**Leave the comments where they were.** The 110 contradictions are the argument. They were not the
result of carelessness in one area: every one of the fourteen parts of the codebase had between five
and fourteen. Nothing would have made any of them fail, and several had already been copied into
`README.md` and into ADRs.

**Keep JSDoc on the public API only.** This repository has no public API in that sense: six
deployables talk over RabbitMQ, and every library is consumed inside the monorepo. The nearest
thing, `libs/contracts`, carried seven of the 110 contradictions in 234 blocks. The HTTP surface is
already described by `@ApiProperty` metadata, which renders at `/api/reference`. Drawing a
"public" line would also need a check to find which exports are on it, and JSDoc on those drifts
exactly as the rest did.

**Lint only `TODO` / `FIXME` with `no-warning-comments`.** At `aca476e` the repository had **zero**
`TODO`, `FIXME`, `XXX` or `HACK` markers. The rule would have reported nothing, and none of the 110
false comments was a marker.

**An ESLint rule instead of a spec.** ESLint does not read SQL, YAML, Dockerfiles or `.http` files.
It does not lint `**/*.config.js` or `migrations/config/**` in this repository. And an
`eslint-disable` comment switches an ESLint rule off, which turns the one exemption the rule must
not have into its escape hatch. A spec cannot be silenced by a comment in the file it reads.

## Consequences

### Positive

- **A stale comment cannot exist**, because a comment cannot exist. What remains can go stale only
  in a document, where it sits with the rest of its area, is anchored to a path and a symbol, and is
  in the diff whenever someone edits that area's document.
- The knowledge is now **findable without knowing which file to open**: an area's invariants,
  ordering and failure modes are in one place.
- The check costs about three seconds of `yarn test:unit`.

### Negative / Trade-offs

- **The IDE shows less.** Hovering a symbol no longer shows a JSDoc paragraph. The reason behind a
  line is one link away, in a file the editor does not open for you.
- **Documents drift too.** `docs/reference/` has no check that a claim is still true; only its links
  and anchors can be checked mechanically. It stays true only if a pull request that changes
  behaviour updates it, which is a review obligation that costs time in every such change.
- **Names and test titles carry more weight.** A function whose purpose is not clear from its name
  and its tests now has nowhere to explain itself locally. That pressure is partly the point; it is
  still a cost.
- **The check is not total** (§4): some comments would pass it, and only review catches those.

## References

- [ADR-003](003-record-architecture-decisions.md) — the ADR format; accepted ADRs are not edited.
- [ADR-049](049-the-port-methods-nothing-calls.md), [ADR-060](060-what-drains-a-domain-event.md) —
  comments that vouched for callers and mechanisms that did not exist.
- [ADR-053](053-how-a-transition-window-closes.md) — a rule ships with the check that enforces it.
- [`docs/reference/README.md`](../reference/README.md) — how a reference entry is written.
- `spec/no-code-comments.spec.ts` — the check; [`testing.md`](../reference/testing.md#no-code-commentsspects)
  describes it.
