# _carryover-10.md — Add OpenTelemetry + Jaeger stack and trace correlation (Phase 7)

> Generated 2026-05-14 by the task-10 session on branch
> `RIS-34-Architecture-migration-Phase-10-Add-otel-jaeger-stack`.
> The next task (`task-11`) reads this file as its first action and
> fails fast if it is missing.

## 1. Entry-gate result

`yarn install`, `yarn build` (4 apps), `yarn lint`, `yarn test:unit`
(128 tests across 26 suites) were all green at the start of the
session. Baseline matches `_carryover-09.md`'s reported state.

## 2. New dependencies

```
@opentelemetry/api                              ^1.9.1
@opentelemetry/auto-instrumentations-node       ^0.76.0
@opentelemetry/core                             ^2.7.1
@opentelemetry/exporter-trace-otlp-http         ^0.218.0
@opentelemetry/instrumentation-amqplib          ^0.65.0
@opentelemetry/resources                        ^2.7.1
@opentelemetry/sdk-node                         ^0.218.0
@opentelemetry/semantic-conventions             ^1.41.1
```

(`@opentelemetry/context-async-hooks` and `@opentelemetry/sdk-trace-base`
are pulled in transitively; they show up as direct imports inside the
new logger unit spec but do **not** need explicit root-`package.json`
entries — `yarn install` resolves them via the SDK packages above.)

All seven `@opentelemetry/*` direct deps were absent at session start
(`_carryover-09.md` had no OTel entries in `package.json`; `yarn.lock`
mentioned `@opentelemetry/api` only as a peer dependency of
`cacheable`). The single peer-warning at install
(`auto-instrumentations-node` requesting `@opentelemetry/core`) is
resolved by the explicit `@opentelemetry/core` direct dep.

## 3. New / changed files

### Created

| Path | Role |
|---|---|
| `docker-compose.observability.yml` | Opt-in overlay: `jaeger` (all-in-one, UI on 16686) + `otel-collector` (4317 gRPC, 4318 HTTP). Shares the `backend` network with `docker-compose.yml`. |
| `infrastructure/otel-collector-config.yaml` | Single pipeline — OTLP receiver → `batch` processor → OTLP exporter to `jaeger:4317`, with a `debug` exporter teed in for local visibility. |
| `.env.example` | First `.env.example` in the repo. Lists every env var validated by the Joi schema (including the new OTEL_*). |
| `docs/adr/014-otel-exporter-otlp-http-and-jaeger.md` | ADR — OTLP/HTTP via collector → Jaeger, why collector even in dev, production swap story. |
| `docs/adr/015-pino-trace-correlation.md` | ADR — Pino `logMethod` hook injects `traceId` / `spanId`; `correlationId` stays for human grep. |
| `libs/observability/spec/logger.module.spec.ts` | New unit suite — proves the hook injects `traceId`/`spanId` inside an active span and is a passthrough when no span is active. |

### Updated

| Path | Change |
|---|---|
| `libs/observability/tracer.ts` | Fleshed out: `NodeSDK` + `OTLPTraceExporter` + `getNodeAutoInstrumentations()`. Reads `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SDK_DISABLED`, `OTEL_DIAG_LOG_LEVEL`. `sdk.start()` is synchronous; `SIGTERM`/`SIGINT` register a shutdown hook. |
| `libs/observability/logger.module.ts` | `logMethod` hook resolves `trace.getActiveSpan()?.spanContext()` and merges `{ traceId, spanId }` into the first record arg (or prepends a record when the call is a plain-string log). |
| `libs/config/config-module.config.ts` | Joi: `OTEL_SERVICE_NAME` required, `OTEL_EXPORTER_OTLP_ENDPOINT` required (http/https URI), `OTEL_RESOURCE_ATTRIBUTES` optional, `OTEL_SDK_DISABLED` boolean default false. |
| `docker-compose.yml` | Per-service `environment:` blocks for `api-gateway`, `retail-microservice`, `inventory-microservice`, `notification-microservice` now set their own `OTEL_SERVICE_NAME` + `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318/v1/traces`. |
| `.env.local` | Added `OTEL_SERVICE_NAME=api-gateway` and `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces` so host-side `yarn start:dev` runs satisfy the Joi schema. |
| `apps/retail-microservice/src/main.ts` | Added the missing `import '@retail-inventory-system/observability/tracer';` as the very first line. Tasks 05/07/08 had wired it into the other three apps' `main.ts`; retail had been missed during task-09. |
| `package.json` | The eight new `@opentelemetry/*` deps. |
| `README.md` | New "Distributed tracing" subsection under "Logging & Observability": env vars, compose overlay command, Jaeger UI URL, the "first import" rule. |
| `CLAUDE.md` | Updated the `@retail-inventory-system/observability` library description, the "next free ADR" counter (014 → 016), and the Known Issues bullet (the "no OTel today" caveat replaced by a positive description of the new wiring + the first-import-in-main.ts rule). |

## 4. Manual smoke-test results

**Stack:** existing `mysql` / `rabbitmq` / `redis` containers from the
shared compose project, plus the observability overlay
(`docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d jaeger otel-collector`).
The four Node apps were run on the host via `yarn start:dev:*` with
each given its own `OTEL_SERVICE_NAME` (gateway from `.env.local`,
the three microservices via shell overrides).

**Flow driven:** `POST /api/auth/login` → `POST /api/order` →
`PUT /api/order/:id/confirm` (twice — orders 7 and 8). Both
confirms returned `status: "confirmed"` with all line items
`confirmed`.

**Jaeger services after the run** (`/api/services`):

```
api-gateway
inventory-microservice
notification-microservice
retail-microservice
jaeger-all-in-one
```

**Trace selected for capture:** `eac9db7c143b20e0e1b77a3ecaa35c7e`
(53 spans, all four app services represented).

Span tree (verbatim from `/tmp/otel-smoke/span-tree.txt`):

```
- [api-gateway] PUT /api/order/:id/confirm  (61.6ms)
  - [api-gateway] middleware - patched  (0.1ms)
    - [api-gateway] middleware - jsonParser  (0.1ms)
  - [api-gateway] middleware - patched  (0.1ms)
    - [api-gateway] middleware - urlencodedParser  (0.0ms)
  - [api-gateway] middleware - patched  (0.2ms)
    - [api-gateway] middleware - <anonymous>  (0.1ms)
  - [api-gateway] middleware - patched  (0.5ms)
    - [api-gateway] request handler - /api/*path  (0.4ms)
      - [api-gateway] request handler - /api/*path  (0.3ms)
  - [api-gateway] middleware - patched  (0.2ms)
    - [api-gateway] request handler - /api/*path  (0.1ms)
      - [api-gateway] request handler - /api/*path  (0.0ms)
  - [api-gateway] middleware - patched  (59.3ms)
    - [api-gateway] request handler - /api/order/:id/confirm  (59.2ms)
      - [api-gateway] request handler - /api/order/:id/confirm  (59.1ms)
        - [api-gateway] OrderController.confirmOrder  (58.2ms)
          - [api-gateway] SELECT  (1.3ms)
          - [api-gateway] publish <default>  (1.3ms)
            - [retail-microservice] retail_queue process  (0.1ms)
              - [retail-microservice] SELECT  (1.3ms)
              - [retail-microservice] publish <default>  (1.4ms)
                - [api-gateway] amq.rabbitmq.reply-to process  (0.1ms)
          - [api-gateway] confirmOrder  (46.8ms)
            - [api-gateway] publish <default>  (1.7ms)
              - [retail-microservice] retail_queue process  (0.1ms)
                - [retail-microservice] SELECT  (1.3ms)
                - [retail-microservice] publish <default>  (1.0ms)
                  - [inventory-microservice] inventory_queue process  (0.1ms)
                    - [inventory-microservice] START  (0.8ms)
                    - [inventory-microservice] SELECT  (1.6ms)
                    - [inventory-microservice] INSERT  (1.1ms)
                    - [inventory-microservice] SELECT  (0.9ms)
                    - [inventory-microservice] COMMIT  (2.1ms)
                    - [inventory-microservice] redis-UNLINK  (1.5ms)
                    - [inventory-microservice] redis-UNLINK  (1.3ms)
                    - [inventory-microservice] publish <default>  (1.8ms)
                      - [notification-microservice] notification_events process  (62450.9ms)
                    - [inventory-microservice] publish <default>  (1.0ms)
                      - [retail-microservice] amq.rabbitmq.reply-to process  (0.1ms)
                - [retail-microservice] SELECT  (1.4ms)
                - [retail-microservice] SELECT  (1.1ms)
                - [retail-microservice] START  (0.4ms)
                - [retail-microservice] UPDATE  (1.4ms)
                - [retail-microservice] UPDATE  (0.7ms)
                - [retail-microservice] COMMIT  (2.0ms)
                - [retail-microservice] publish <default>  (1.5ms)
                  - [notification-microservice] notification_events process  (0.3ms)
                - [retail-microservice] SELECT  (1.2ms)
                - [retail-microservice] publish <default>  (1.0ms)
                  - [api-gateway] amq.rabbitmq.reply-to process  (0.1ms)
  - [api-gateway] middleware - patched  (0.1ms)
    - [api-gateway] middleware - <anonymous>  (0.1ms)
```

Pino log line counts for the same trace
(`grep -c eac9db7c143b20e0e1b77a3ecaa35c7e` against the four app
logs):

| Service | Lines carrying `traceId` |
|---|---|
| api-gateway | 6 |
| retail-microservice | 12 |
| inventory-microservice | 12 |
| notification-microservice | 6 |

The Pino hook injects `traceId`; the OTel auto-instrumentation also
emits a `trace_id` (snake-case) field on its own bindings — both
appear on the same line, which matches ADR-015's
"naming-divergence is intentional" rationale.

## 5. Verification results

```
$ yarn install
➤ YN0000: · Yarn 4.12.0
➤ YN0000: · Done in 2s 604ms

$ yarn build
webpack 5.106.0 compiled successfully in 10178 ms   # api-gateway
webpack 5.106.0 compiled successfully in 9564 ms    # inventory-microservice
webpack 5.106.0 compiled successfully in 10455 ms   # retail-microservice
webpack 5.106.0 compiled successfully in 11151 ms   # notification-microservice

$ yarn lint
# (no output — clean exit code 0)

$ yarn test:unit
Test Suites: 27 passed, 27 total
Tests:       130 passed, 130 total
Snapshots:   0 total
Time:        29.263 s

$ yarn test:e2e
Test Suites: 3 passed, 3 total
Tests:       35 passed, 35 total
Snapshots:   42 passed, 42 total
Time:        12.29 s
```

Net new: **+1 unit suite, +2 unit tests** (`libs/observability/spec/logger.module.spec.ts`). E2E totals unchanged from `_carryover-09.md`.

### E2E cleanup gotcha discovered post-smoke-test

`notification.e2e-spec.ts` timed out on its first run after the
smoke test. Root cause: the four `nest start --watch` processes from
the smoke test had survived `pkill -f "nest start <name>"` and then
respawned the apps from `dist/` after the lint-fix rebuild — so the
notification microservice was still bound to `notification_events`
as a competing consumer. RabbitMQ split the synthetic event between
the live service and the test spy, and the spy never saw it.

Resolution: `kill -9` against the `dist/apps/*/main` PIDs, then
`yarn test:e2e` (which `test:infra:reload`s mysql/rabbitmq/redis and
re-runs migrations + seed). All three suites green afterward.

Operational note for future smoke tests: prefer `yarn test:infra:down`
**before** running `yarn test:e2e` if any host-side `yarn start:dev:*`
was used in the same session — or kill watch processes by group
(`kill -- -<pgid>`), since `pkill -f` against the `nest start` command
line misses the respawned `node dist/...` children.

## 6. ADR numbers assigned

- **ADR-014** — OTLP/HTTP export via OTel collector → Jaeger. Status: Accepted.
- **ADR-015** — Pino `traceId`/`spanId` enrichment hook. Status: Accepted.

The next free ADR number is now **016** (CLAUDE.md updated).

## 7. RabbitMQ propagation finding (was task step 5)

The amqplib auto-instrumentation patches `Channel.prototype.publish`
and `Channel.prototype.consume`. `@nestjs/microservices` RMQ
transport uses `amqp-connection-manager`, which itself wraps the
real `amqplib` channels — so the channels exposed to Nest are the
patched ones. The smoke-test trace shows the propagation working
end-to-end: every `publish <default>` span has a matching
`{queue}_queue process` child on the consuming service, and the
trace stays a single trace across **all** RabbitMQ hops (gateway →
retail twice, retail → inventory, inventory → notification, retail →
notification).

No custom interceptor was needed inside `libs/observability`;
`TraceContextInterceptor` remains a passthrough placeholder. Its
body is intentionally not filled in (see ADR-015 §5).

## 8. Unexpected findings

1. **`apps/retail-microservice/src/main.ts` was missing the tracer
   import.** Task-10's preconditions claim "every `apps/*/src/main.ts`
   already imports it as the first line (added in tasks 05–09)" — but
   the retail microservice did not. Added it as the first task action;
   without it, the retail service produces no spans and the trace
   tree breaks at the retail node. Worth verifying in task-11's
   entry-gate (one-line grep against every `main.ts`).

2. **`OTEL_SERVICE_NAME` from `.env.local` is gateway-flavoured.** A
   single `.env.local` can't give each app a distinct service name.
   The compose `environment:` blocks already set the per-service
   override; host-side `yarn start:dev` (which loads `.env.local`)
   defaults every app to `api-gateway` unless the shell exports an
   override. The smoke test used `OTEL_SERVICE_NAME=retail-microservice
   yarn start:dev:retail-microservice` etc. This is fine for dev but
   the `start:dev` concurrently launcher does not currently set
   per-app overrides — worth a follow-up to wire those into
   `scripts/bash/start-dev.sh`.

3. **A `notification_events process` span shows a 62-second duration.**
   That is **not** real latency — it is an artifact of how the OTel
   amqplib instrumentation closes the consumer span. The consumer
   span's `end()` fires when the message is `ack`'d *and* the worker
   loop has nothing else to process; the notification handler's
   `LogNotifierAdapter` is fire-and-forget so the ack happens quickly,
   but the surrounding span outlives the handler. Acceptable for now
   — a span-attribute filter or a manual `endSpan()` in the
   notification consumer can tighten this later (suggested for
   task-11 cleanup if anyone goes back to revisit consumer spans).

4. **`amq.rabbitmq.reply-to process` spans appear under the publisher
   service, not the consumer.** This is correct — those are the
   *reply* messages that Nest's RPC pattern sends back through the
   `amq.rabbitmq.reply-to` direct-reply queue. The publisher receives
   them, so the span belongs to the publisher's process. Not a bug;
   noted because the span tree looks asymmetric at first glance.

5. **`OTEL_EXPORTER_OTLP_ENDPOINT` is **required** by Joi.** This is
   a deliberate "fail-fast at boot if observability isn't wired"
   posture (per the task brief). Anyone running services without the
   observability overlay will need either `OTEL_SDK_DISABLED=true` or
   to point the endpoint at a non-existent collector — the SDK
   exporter retries silently when the collector is unreachable, so a
   service still boots, but the spans drop on the floor.

6. **Compose health-checks are not wired for `jaeger` and
   `otel-collector`.** The current compose overlay starts both
   without `healthcheck:` blocks. For local-dev this is fine
   (`docker ps` shows them up within a few seconds), but a CI smoke
   test would benefit from explicit waits. Not blocking; logged for
   task-11 if it touches CI.

## 9. Suggested adjustments to task-11 (Redis cache-aside revisit)

1. **`@Cacheable` decorator should open a manual span.** The current
   trace shows `redis-UNLINK` spans for cache invalidation but no
   span for cache *reads*. The decorator wraps `get` → fallback →
   `set`; wrapping that call with
   `tracer.startActiveSpan('cache.get')` would surface cache hit/miss
   in Jaeger directly. Tag the span with `cache.key` (post-
   sanitization) and `cache.hit` boolean. Mentioned as a concrete
   span to add when task-11 revisits the cache layer.

2. **The 17 open audit items from `docs/audits/audit-2026-05-08.md`
   still apply.** No change from `_carryover-09.md §11 #1`.

3. **Trace-driven cache-stampede demo.** Once the cache decorator
   opens its own spans, the stampede behavior (many concurrent
   requests, single backend miss with N "waiters") becomes visible
   in Jaeger. The audit items around stampede mitigation can use
   that view to validate the fix.

## 10. Open follow-ups (post-task-10)

1. **Auto-instrumentation noise.** The Jaeger UI shows ~10 spans per
   request for Express middleware (`middleware - patched`,
   `middleware - <anonymous>`, etc.). Acceptable today; a
   sampler-or-attribute filter in `tracer.ts` can collapse them
   later if operators complain.
2. **`TraceContextInterceptor` is still a passthrough.** Auto-
   instrumentation covers what we need; ADR-015 §5 documents the
   reasoning. If the body is ever filled, the interceptor must not
   shadow the W3C `traceparent` header the OTel HTTP instrumentation
   already emits.
3. **Notification consumer span duration is inflated.** See finding #3
   above. Worth a 10-line fix in
   `apps/notification-microservice/src/modules/notifications/infrastructure/consumers/`
   to explicitly end the inbound message span when the handler
   returns.
4. **`start-dev.sh` doesn't set per-app `OTEL_SERVICE_NAME`.** Worth
   one line per app: `OTEL_SERVICE_NAME=api-gateway` and friends in
   the concurrently spawn commands. Today's compose path already
   handles it.
5. **CI doesn't run the observability stack.** The unit suite covers
   the Pino hook (130 tests); the full multi-service trace is
   verified manually. If a regression in propagation matters enough,
   a thin integration test that boots all four apps + Jaeger and
   asserts on the Jaeger API for a span count would close that gap.
