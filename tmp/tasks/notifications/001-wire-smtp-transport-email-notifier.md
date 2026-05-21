# Task 001: Scaffold only. TODO(post-migration): wire an SMTP transport (nodemailer or a managed provider) and rebind `NOTIFIER` in `notifications.module.ts`. The dependency is intentionally not in `package.json` yet — adding it now would force a choice of provider before the business need is settled.

## Source
- **File:** `apps/notification-microservice/src/modules/notifications/infrastructure/delivery/email.notifier.adapter.ts`
- **Line:** 6
- **Service / Module:** notification-microservice / notifications

## Context
`EmailNotifierAdapter` is one of three `INotifierPort` implementations under
`apps/notification-microservice/src/modules/notifications/infrastructure/delivery/`. Today only
`LogNotifierAdapter` is bound in `notifications.module.ts`; `EmailNotifierAdapter` is a scaffold
whose `send()` throws `Error('EmailNotifierAdapter: not implemented')`. The TODO exists because
ADR-011 reserved the adapter slot in the DI graph so the port shape is stable, but the project
deliberately deferred picking a mail provider until the business need is settled (no SMTP
library is in `package.json`).

## Objective
Replace the stub with a working SMTP delivery implementation behind `INotifierPort` and make
it selectable as the `NOTIFIER` binding without touching domain or use-case code.

## Suggested Implementation Steps
1. Add an SMTP client dependency to `package.json` (e.g. `nodemailer` + `@types/nodemailer`)
   and document the choice and rationale alongside the adapter file.
2. Introduce env-driven configuration via `libs/config` — host, port, secure flag, auth user,
   auth pass — and validate it in the Joi schema so the adapter cannot boot with partial config.
3. Implement `EmailNotifierAdapter.send(notification)` to map the `Notification` value object
   (channel, subject, body, recipient address) to a `nodemailer` `sendMail` call; surface
   transport errors as rejected Promises so the consumer's await chain logs them.
4. Rebind `NOTIFIER` in `apps/notification-microservice/src/modules/notifications/infrastructure/notifications.module.ts`
   to `EmailNotifierAdapter` via `useClass` (or behind a `NOTIFIER_DRIVER` env switch if both
   `log` and `email` should remain selectable for local dev).
5. Add a unit test that mocks `nodemailer.createTransport` and asserts the adapter calls
   `sendMail` with the mapped fields; add an e2e smoke test that boots the microservice with a
   fake SMTP server (e.g. `smtp-tester`).
6. Remove the `TODO(post-migration)` comment block on lines 6–9 once the adapter is real.

## Acceptance Criteria
- [ ] `EmailNotifierAdapter.send` no longer throws `not implemented` for valid input.
- [ ] `package.json` lists the SMTP client dependency (and its `@types/*` if needed) with no
      peer-dependency warnings on `yarn install`.
- [ ] The Joi schema in `libs/config` fails fast when SMTP env vars are missing while the
      email adapter is the bound `NOTIFIER`.
- [ ] `yarn lint --max-warnings 0` passes; no new `boundaries/*` violations.
- [ ] A unit test mocking `nodemailer` asserts the field mapping `Notification -> SendMailOptions`.
- [ ] The scaffold TODO comment on lines 6–9 is removed.

## ⚠️ Important Constraint
When implementing this task, do NOT reference the `tmp/` directory or any file within it
in documentation, code comments, ADRs, or any other user-facing or developer-facing text.
The `tmp/tasks/` directory is a transient scratch space. All permanent documentation belongs
in `docs/`, `README.md`, or inline in source files.
