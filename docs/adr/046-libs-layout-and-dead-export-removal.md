# ADR-046: The `libs/` layout, and four exports nothing imports

- **Date**: 2026-07-12
- **Status**: Accepted

---

## Context

A pass over `libs/` — nine libraries — for layout consistency turned up two things (the fourth dead export, `CacheHelper`, surfaced later, from the very validation check §4 adds). The layout was the question asked. The dead exports were the thing worth finding.

### Two conventions, and one of them applied where it shouldn't be

| | libraries |
| --- | --- |
| **Grouped** into subfolders | `contracts` (8), `common` (5), `cache` (`decorators/`) |
| **Flat, and rightly so** | `database` (5 files), `ddd` (6), `config` (1) |
| **Flat, with an obvious family inside** | `messaging` (12 root files — **7** of them `microservice-client-*`), `auth` (12 — 3 guards + 4 decorators), `observability` (8 — 4 correlation files) |

The third row is the problem. `libs/messaging`'s flat list reads as a dozen unrelated things, when more than half of it is one family.

### Four exports with no consumer — and a comment saying otherwise

| Export | What its comment claims | What the code does |
| --- | --- | --- |
| `RabbitmqClientFactory` | *"Used by callers that want a one-off proxy … (tests, bootstrap scripts)"* | **zero** callers — including in `test/` and `scripts/` |
| `MetricsModule` | *"Empty today **so app modules can already declare the import**"* | **zero** app modules import it |
| `TraceContextInterceptor` | *"a no-op **so app modules can declare the import** without churn"* | **zero** app modules import it |
| `CacheHelper` | ADR-006: *"kept for one release"*; still listed as live `cache` API by the map | **zero** callers. ADR-006's §Open **already queued its deletion** "behind the next cache-key version bump" — the inventory key has since gone `v1 → v2 → v3`, so the condition was met three times and nobody acted |

`CacheHelper` is the instructive one: it is not undocumented rot but a **scheduled removal nobody executed**. A deletion queued behind a condition, with no owner and no check, is not queued — it is forgotten. Deleting it orphaned `CACHE_KEYS.productStock`, whose only caller it was; that builder goes too, while `productStockPrefix` — which the SCAN-based invalidate path genuinely still needs — stays.

The two placeholders justify themselves by a usage the code contradicts: they exist so that callers can import them, and no caller imports them. That is not a reserved surface — it is dead code with a story attached, and the story is what makes it dangerous. `README.md` and ADR-008 both list `RabbitmqClientFactory` as part of the messaging API, so the next contributor believes it is load-bearing.

This is the [ADR-043](043-lifting-forced-duplicates-into-shared-libs.md) `MessagingModule` pattern exactly: a lib export whose only importer was one that did not use it.

**The distinction that matters.** This repository does keep deliberately reserved surfaces — the unused `EXCHANGES` members, the unused `CACHE_KEYS` builders. Those are **one line in a registry**, where being a complete registry is the point. These four are *implementations* — three of them files — each asserting it has users.

### The map was wrong in both directions

The repo's documentation was validated (2026-07-12) for "everything stated exists". It was never validated for **"everything that exists is stated"** — and that blind spot let both errors stand:

- it **lists** `RabbitmqClientFactory` (dead);
- it **omits** `sendPreservingRpcError` (live — four retail adapters) and `enforceRequiredClaim` (live — two guards).

## Decision

### 1. Delete the four dead exports

`libs/messaging/rabbitmq.client.factory.ts`, `libs/observability/metrics.module.ts`, `libs/observability/trace-context.interceptor.ts`, `CacheHelper` (in `libs/cache/cache-keys.ts`), and their barrel entries. ADR-007 §, ADR-008's API table and ADR-015 are amended.

If Prometheus metrics or a response-header trace interceptor are wanted later, they will be written then, against the requirement that exists then. An empty class today buys nothing: nothing imports it, so nothing is spared "churn" by its existence.

### 2. Group the three flat libraries by family

```
libs/messaging/  12 → 5 root      libs/auth/  12 → 5 root      libs/observability/  8 → 3 root
├── clients/         (7)          ├── guards/      (4)          ├── correlation/   (4)
├── exchanges.constants.ts        ├── decorators/  (4)          ├── testing/       ← tsconfig alias
├── routing-keys.constants.ts     ├── auth.module.ts            ├── logger.module.ts
├── ris-events-mirror.publisher.ts├── auth-user-validator.port.ts└── tracer.ts     ← tsconfig alias
└── rpc-passthrough.ts            ├── jwt.strategy.ts
                                  └── role.enum.ts
```

`decorators/` is not an invention — `libs/cache/decorators/` already establishes it. `claim-guard.util.ts` goes into `guards/`, its only two callers.

`database`, `ddd` and `config` stay flat. Five or six coherent files do not need a folder to explain them, and adding one would be structure for its own sake.

**`tracer.ts` and `testing/` do not move.** They are the only two deep-import paths into any lib (`@retail-inventory-system/observability/{tracer,testing}`), pinned in `tsconfig.json`; `main.ts` depends on `tracer` being the first import in the process.

### 3. This reorganisation is invisible from outside

Every other consumer reaches a lib through its barrel, so no import in `apps/` changed. And the `boundaries` element patterns are `libs/<name>/**` — subfolders are transparent to the linter, so there is no rule to update and no rule that could break. Zero behaviour change; `yarn lint`, `build`, 1777 unit tests and 58 e2e suites all pass untouched.

The honest framing: **§2 is cosmetics.** It buys readability and nothing else, and it moves the blame on fifteen files. §1 and §4 are not.

### 4. The map now lists what is live, and only what is live

The docs drop the four dead names and gain `sendPreservingRpcError` (the RPC-error-preserving `send` the four cross-service retail adapters use) and `enforceRequiredClaim`.

### 5. The map sheds what one `ls` reproduces

The map had **2 bytes** of headroom against its 40 KB gate, and every addition was forcing a
purge of something useful. The cause was a category error in its own charter: "the map"
admits anything that says *where a thing is* — but an agent has `ls`, `grep` and `glob`.

**An enumeration that one `ls` reproduces is not a map. It is ballast — and it is the part that
rots.** Every ADR in this run had to rewrite those lines; all three wrong-file-placement errors
found on 2026-07-12 lived in them; and one stale entry survived even that validation pass
(notification's `Presentation:` still listed `health.controller.ts` after ADR-044 moved it to
`app/` — the validator only checks that a named file *exists*, not that it is where the map says).

Four cuts, 41 KB → 31.5 KB (**23 % headroom**):

| | Cut | Where it went |
| --- | --- | --- |
| A | The Shared Libraries table (3.6 KB) | **Deleted** — `README.md` §3 already had it: a summary of something with a home, maintained *twice* for every ADR in this run. |
| B | `Use cases:` / `Infra:` / `Presentation:` enumerations (~6.5 KB) | **Deleted** — each is one `ls`. |
| C | The routing-key → use-case tables (5.5 KB → 1.5 KB) | **Moved** to `README.md` §2 *RPC surface*. The map keeps the namespace → queue → controller topology, and the *surprises*: the five inventory RPCs with no gateway route, `record-outcome` being RPC-only, `audit.staff.action` being an event not an RPC, health handlers doing no I/O. |
| D | The background-jobs table (0.8 KB) | **Pointer** — `README.md` §13 has it plus the cadences and the cost of a missed tick. |

What survives is what an agent **cannot** cheaply derive: the **landmines**, the constraints that
fail CI, the commands, and the topology `grep` will not answer — which deployable owns which
module, which module owns which table, and the **port symbols a use case injects** (kept: getting
one wrong is a DI failure at boot).

## Consequences

### Positive

- Four lib exports that lied about being used are gone, along with the ADR entries that vouched for them.
- `libs/messaging` reads as five things instead of twelve; `libs/auth` as five instead of twelve.
- The map's second direction — *does everything that exists appear here?* — is now a stated validation check, not an assumption. It is what found `CacheHelper`.
- The map has **23 % headroom** instead of 2 bytes, and the landmines — its highest-value bytes, and the only content an agent cannot derive — are no longer competing for space with `ls` output.

### Negative

- §2 is pure churn against `git blame` for fifteen files, and buys no correctness.
- §5 costs an agent 1–2 extra tool calls per module it touches, to `ls` what the map used to spell out. That is the trade, and it is a good one: tool calls are cheap, a 41 KB preamble on *every* turn is not — and a **stale** map is actively harmful, by the file's own preamble.
- A future metrics module starts from nothing rather than from an empty class. That is the intent: an empty class is not a head start.

## Alternatives considered

- **Keep the placeholders, they cost nothing.** They cost the thing that matters most in a map: trust. The docs listed `RabbitmqClientFactory` as API and a reader would have used it believing it was exercised. A reserved surface that is *one line in a registry* is cheap; a file with an implementation and a false claim of use is not.
- **Group `database` / `ddd` / `config` too, for uniformity.** Rejected: uniformity is not the goal, legibility is. Six files in `libs/ddd` are already legible; a folder would add a hop and explain nothing.
- **A `constants/` folder in `libs/messaging`** for the two `*.constants.ts`. Rejected for the same reason — two files.
- **Move `tracer.ts` under a folder for symmetry.** Rejected outright: it is a deep-import path with a `tsconfig` alias, and `main.ts`'s first-import contract (ADR-007) depends on it resolving.

---

## References

- [ADR-007](007-pino-and-opentelemetry.md) / [ADR-015](015-pino-trace-correlation.md) — introduced `TraceContextInterceptor` and `MetricsModule` as placeholders; **both are removed here**.
- [ADR-008](008-rabbitmq-via-libs-messaging.md) — its API table lists `RabbitmqClientFactory`; **that entry is removed here**, as `MessagingModule`'s was by ADR-043.
- [ADR-006](006-cache-aside-via-libs-cache.md) — shipped `CacheHelper` as a one-release shim and **queued its removal in §Open**; that note is closed here, three key-versions late.
- [ADR-005](005-split-shared-common-into-bounded-libs.md) — the lib taxonomy this tidies.
- [ADR-043](043-lifting-forced-duplicates-into-shared-libs.md) — the same finding one library over: an export with no real consumer.
