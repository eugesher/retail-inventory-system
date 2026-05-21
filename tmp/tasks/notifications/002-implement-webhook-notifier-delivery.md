# Task 002: Scaffold only. TODO(post-migration): POST the serialized notification to a configured webhook URL (with retries + signed payloads). Kept as a stub so the adapter slot exists in the DI graph and ADR-011 can reference it.

## Source
- **File:** `apps/notification-microservice/src/modules/notifications/infrastructure/delivery/webhook.notifier.adapter.ts`
- **Line:** 6
- **Service / Module:** notification-microservice / notifications

## Context
`WebhookNotifierAdapter` is the third `INotifierPort` implementation, alongside
`LogNotifierAdapter` (currently bound) and `EmailNotifierAdapter`. Its `send()` throws
`Error('WebhookNotifierAdapter: not implemented')`. The TODO acknowledges that ADR-011 needed
the adapter slot to exist for DI-graph completeness, but deferred the actual HTTP-out
implementation — including the security-sensitive concerns (signed payloads, retry policy)
that have to be designed before code is written.

## Objective
Implement signed, retry-aware webhook delivery behind `INotifierPort` so the adapter can be
bound as the `NOTIFIER` and reliably deliver notifications to a configured HTTPS endpoint.

## Suggested Implementation Steps
1. Add an HTTP client dependency suitable for the Node target (e.g. `undici` or
   `@nestjs/axios`) and a retry library (e.g. `async-retry`) to `package.json`.
2. Add env-driven config in `libs/config`: `WEBHOOK_URL`, `WEBHOOK_SECRET`,
   `WEBHOOK_TIMEOUT_MS`, `WEBHOOK_MAX_RETRIES`; Joi-validate them so the adapter refuses to
   boot with partial config.
3. Implement `WebhookNotifierAdapter.send(notification)` to:
   - serialize the `Notification` value object to JSON;
   - sign the payload with HMAC-SHA256 (`WEBHOOK_SECRET`) and attach the signature as a
     header (e.g. `X-Notification-Signature`);
   - POST with timeout and exponential-backoff retries on 5xx/network errors only (4xx
     responses must surface immediately — they indicate the consumer rejected the payload).
4. Rebind `NOTIFIER` in
   `apps/notification-microservice/src/modules/notifications/infrastructure/notifications.module.ts`
   to `WebhookNotifierAdapter` (or behind a `NOTIFIER_DRIVER` switch if multiple adapters
   should remain selectable).
5. Add unit tests with a mocked HTTP client covering: successful POST, retry on 5xx, no
   retry on 4xx, signature header presence and correctness.
6. Remove the `TODO(post-migration)` comment block on lines 6–8 once the adapter is real.

## Acceptance Criteria
- [ ] `WebhookNotifierAdapter.send` performs an authenticated HTTPS POST with a signed body.
- [ ] 5xx and network errors trigger exponential-backoff retries up to `WEBHOOK_MAX_RETRIES`;
      4xx responses are not retried.
- [ ] `WEBHOOK_SECRET` is read from env and never logged (verified by inspecting Pino
      redaction config in `libs/observability`).
- [ ] `yarn lint --max-warnings 0` passes; no new `boundaries/*` violations.
- [ ] Unit tests cover success, 5xx retry, 4xx non-retry, and signature integrity.
- [ ] The scaffold TODO comment on lines 6–8 is removed.

## ⚠️ Important Constraint
When implementing this task, do NOT reference the `tmp/` directory or any file within it
in documentation, code comments, ADRs, or any other user-facing or developer-facing text.
The `tmp/tasks/` directory is a transient scratch space. All permanent documentation belongs
in `docs/`, `README.md`, or inline in source files.
