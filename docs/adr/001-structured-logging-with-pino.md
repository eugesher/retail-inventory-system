# ADR-001: Structured Logging with Pino and Correlation IDs

**Status:** Accepted

---

## Context

The system runs four NestJS services that communicate asynchronously via RabbitMQ. When a request fails or behaves unexpectedly, diagnosing the cause requires reading log output from multiple processes — the API gateway that received the HTTP request, the retail microservice that processed it, and the inventory microservice that may have been called in turn.

Before this change, each service used the built-in NestJS `ConsoleLogger` through a thin `SystemLogger` wrapper that suppressed framework bootstrap noise. This produced unstructured plaintext with no request context:

```
[Nest] LOG [OrderCreateService] Order created
[Nest] LOG [ProductStockOrderConfirmService] Stock reserved
```

There was no way to determine which log lines belonged to the same request, or to programmatically query, aggregate, or alert on log data.

---

## Decision

Adopted [Pino](https://github.com/pinojs/pino) via `nestjs-pino` for structured JSON logging across all services.

**Correlation ID propagation** is implemented as follows:

1. A `CorrelationMiddleware` runs on every inbound HTTP request at the API gateway. It reads the `x-correlation-id` request header, generating a UUID v4 if the header is absent. The ID is echoed back in the response header.
2. The API gateway binds the ID to its pino logger via `logger.assign({ correlationId })`. All subsequent log calls in the same HTTP request scope include it automatically through pino's `AsyncLocalStorage` integration.
3. The ID is included in every outbound RabbitMQ message payload as the `correlationId` field.
4. Microservices extract `correlationId` from the payload and include it explicitly in every log call. Microservices do not use `logger.assign()` because they operate outside the HTTP context where `AsyncLocalStorage` is initialised.

**Logger configuration** is centralised in `libs/config/logger/logger.config.ts` as a `LoggerConfig` class that implements the `nestjs-pino` `Params` interface. It:

- Tags every log line with an `app` field identifying the emitting service.
- Redacts `Authorization`, `Cookie`, and `Set-Cookie` headers.
- Suppresses framework bootstrap noise (`InstanceLoader`, `RouterExplorer`, etc.) in non-production environments.
- Enables `pino-pretty` in non-production environments for human-readable output.
- Respects a `LOG_LEVEL` environment variable, defaulting to `debug` in development and `info` in production.

---

## Alternatives Considered

**Winston** — higher ecosystem adoption, but significantly slower than Pino (Pino is the fastest Node.js JSON logger by benchmark). Winston's NestJS integration is less idiomatic and requires more boilerplate to achieve structured output. Its transport system is heavier than Pino's minimal worker-thread approach.

**Built-in NestJS Logger (`ConsoleLogger`)** — zero additional dependencies, but produces unstructured plaintext. Has no concept of request context, no field-level structured output, and no integration with log aggregation systems. Cannot be used to programmatically filter or alert on specific log fields.

**OpenTelemetry** — a more comprehensive observability solution, but significant added complexity (SDK, collector, trace exporter, sampler configuration) for a system at this stage. Pino structured logging is a prerequisite for, not a replacement of, OpenTelemetry tracing — the two are complementary.

---

## Consequences

**Positive:**

- Every log line is machine-parseable JSON, enabling aggregation with tools such as Datadog, Grafana Loki, or Elasticsearch.
- Any request can be traced across all services by filtering on a single `correlationId` value: `jq 'select(.correlationId == "...")'`.
- Log level can be changed at runtime via the `LOG_LEVEL` environment variable without a code change.
- Sensitive headers are redacted automatically and cannot leak into log aggregation pipelines.
- Developer experience is preserved: `pino-pretty` formats output as colour-coded, human-readable lines in non-production environments.

**Negative:**

- Log volume increases slightly compared to plaintext logging due to per-line JSON field overhead.
- Microservice services cannot use `logger.assign()` because they run outside the HTTP request scope. `correlationId` must be passed explicitly in every log call — a minor discipline requirement.
- `pino-pretty` is a dev dependency that must not run in production (enforced by the `NODE_ENV` guard in `LoggerConfig`).
