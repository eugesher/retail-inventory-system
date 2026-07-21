---
title: Approval workflows
cluster: Staff & Access Control
effort: 2–3 capabilities
attaches_to:
  - apps/retail-microservice/src/modules/orders/application/use-cases/issue-refund.use-case.ts
  - apps/api-gateway/src/modules/iam/presentation/iam.controller.ts
  - libs/contracts/auth/audit-log-publisher.port.ts
---

# Approval workflows

## Description

An **approval workflow** interposes a second person between an intent and its effect: a refund above a
threshold is *requested*, someone else approves it, and only then does the money move. The same shape
covers granting an administrator role, editing a price, writing off stock — any action where the cost
of a mistake, or of a single dishonest actor, exceeds the cost of waiting.

**The one thing this guide must not do is confuse the two questions the system already answers.** A
permission code answers *"may this person attempt this kind of action?"* — a property of the subject,
decided before the request runs, from a claim in a token. An approval answers *"has **this specific
attempt** been agreed to?"* — a property of one request, decided after it is described and usually by
somebody else. They are different questions with different lifetimes, and the tempting design — a guard
that checks for approval — cannot work, because at the moment the guard runs there is no persisted
attempt for an approval to point at, and the guard cannot know that the approver is a different person
from the requester. **An approval workflow is a state machine in front of a use case, not a stage in
the guard chain.** The chain still runs, unchanged, and still decides who may *request*.

The second confusion, and the one this guide is most exposed to: the audit log's `action` column holds
an **event name** — `RefundIssued`, `StaffUserRolesAssigned` — and never a permission code. An approval
workflow produces new event names (`ApprovalRequested`, `ApprovalGranted`); it does not produce new
values for that column drawn from the permission registry, and filtering the audit log by
`order:refund` is a well-formed query that matches nothing.

## Business needs

- **Separation of duties** — the control that a single compromised or dishonest account cannot move
  money alone. It is the reason approvals exist, and the reason auditors ask for them by name.
- **Error containment** — a mistyped refund of €4,000 instead of €40.00 is caught by a second pair of
  eyes and is otherwise unrecoverable once the gateway has settled.
- **Delegated authority with a ceiling** — a support agent who can refund up to €200 unaided and
  anything larger with a supervisor's agreement is more useful than one who can do neither.
- **Privilege escalation control** — granting someone `iam:role-edit` is the action with the largest
  blast radius in the system, and it is the natural second gate after refunds.
- **A defensible record** — "who approved this, when, and on what information" is the artefact a dispute
  or an audit actually needs.
- The threshold: a shop where one person does everything gains nothing but latency. The first time two
  people hold `order:refund`, or the first material refund loss, is the trigger.

## Attachment points in the current core

- **`IssueRefundUseCase` at
  `apps/retail-microservice/src/modules/orders/application/use-cases/issue-refund.use-case.ts` — the
  natural first gate, and it already has three of the four pieces.** It is reached through a route gated
  on `order:refund`, it **requires an idempotency key**, and it always writes an audit record —
  `RefundIssued` or `RefundFailed` — which it deliberately `await`s rather than treating as best-effort,
  because auditing is integral to a money movement. What it lacks is any notion that the movement might
  need agreeing to first.
- **The auto-refund path through the same use case, which an approval gate must not strand.** A
  cancelled order triggers a refund with a **null actor** — a system origin, audited as staff because
  the audit actor union has no `system` member and the null `actorId` is what signals it. An approval
  requirement applied indiscriminately would leave those refunds waiting for a human who was never
  asked. **A policy that applies to human-initiated requests and not to system-initiated ones is the
  only workable rule here**, and discovering that after shipping is discovering it through a backlog of
  unrefunded cancellations.
- **`IamController` at `apps/api-gateway/src/modules/iam/presentation/iam.controller.ts` — the second
  natural gate, and the one that shows the model is already privilege-aware.** Its six routes are gated
  on three distinct codes: `iam:role-edit` for the role catalogue, `iam:assign` for binding a role to a
  person, and `iam:staff-create` for minting a principal — deliberately separate, because sharing a
  code between granting a role and creating a user would make role assignment a silent user-creation
  escalation ([ADR-047](../adr/047-staff-user-creation-over-http.md)). Approvals extend that reasoning
  from *who may attempt* to *what a second person must agree to*.
- **`IAuditLogEvent` at `libs/contracts/auth/audit-log-publisher.port.ts` — the record the workflow
  produces, and one constraint on it.** The event carries `name` (the classifier), `actorId` +
  `actorKind`, `targetId` + `targetKind`, a structured payload and a correlation id. `AuditTargetKind`
  is a **closed union of `staff-user | customer | role | permission`** — nothing fits an order, which is
  why the refund audit leaves `targetKind` null and puts the ids in the payload. An approval request is
  the same situation: either it rides the payload as the refund's ids do, or the union widens, and
  widening it is a contract change reaching both publishers and the event store.
- **The correlation id, which is what makes the trail one story.** Every audit row and every event
  carries it, and a row written without one is reachable by no correlation filter and appears in no
  trace. A request, its approval and its execution happen in three separate HTTP calls, so **the
  workflow has to propagate the original correlation id deliberately** — the middleware will happily
  mint three unrelated ones.
- **The staff-action audit stream already exists end to end.** `AUDIT_LOG_PUBLISHER` is bound in both
  services that raise audit events, mirrors onto `ris.events` under `audit.staff.action`, and the
  event store's firehose routes it to `audit_log_entry`. New approval events need no new transport,
  no new queue and no new consumer.
- **Idempotency is already the discipline on the money-moving writes.** An approved refund executing
  later is the same request arriving twice from the system's point of view, and the existing key is
  what makes "approve, then execute" safe rather than a second refund.

## Implementation sketch

- **An `ApprovalRequest` aggregate**: the requested action, the **captured parameters**, the requester,
  a state (`pending → approved | rejected | expired | executed`), the approver, timestamps and a reason.
  Capture the parameters at request time and execute *those* — an approval that re-reads its arguments
  at execution time approves one thing and performs another.
- **A rule set, not a hardcoded list.** Which actions need approval, above what threshold, and how many
  approvers — configuration resolved at request time, arriving through a DI value-provider token or a
  table rather than `process.env` in a use case.
- **The requesting route creates a request instead of acting, when the rule fires.** The permission
  gate is unchanged and still runs first: without `order:refund` there is nothing to request. The
  response is a pending request rather than a refund, which is a visible API change and should be a
  distinct status rather than a success that did nothing.
- **Executing an approval calls the existing use case unchanged**, with the captured parameters and the
  original idempotency key. The refund logic is not duplicated, does not learn about approvals, and the
  system-initiated path keeps reaching it directly.
- **A two-person rule, enforced in the domain.** Approver must not be requester — an invariant on the
  aggregate, not a check in a controller, because it is the entire point of the control and it must
  hold on every path that reaches the state change. The system already refuses an analogous
  self-defeating operation in the domain: `StaffUser.revokeRole` will not remove a staff member's last
  remaining role.
- **Approving is its own permission code**, distinct from the code that permits requesting — otherwise
  every person who can refund can approve their own colleague's refund, and the population of approvers
  is identical to the population of requesters. The new code goes into the seed's permission list in the
  same change, or it exists in the enum and reaches no role, `admin` included.
- **Requests expire.** A pending approval with no deadline is a request that is neither done nor
  refused, and the queue fills with them. Expiry is a bounded scheduled sweep — the pattern the
  reservation and delivery-retention sweeps already establish — and it is a state transition, not a
  deletion.
- **Every transition is audited, with event names as the `action`.** `ApprovalRequested`,
  `ApprovalGranted`, `ApprovalRejected`, `ApprovalExpired` — and the payload carries ids, amounts and
  reasons, never personal data ([ADR-037](../adr/037-consent-record-and-tombstone-erasure.md)).
- **Notify both directions** through the existing notification pipeline: the approver that something
  waits, the requester when it resolves. Staff notifications are transactional by their event type,
  so the consent gate is not in play — this is internal operational mail, not marketing.
- **Events** ride `ris.events` (`approval.request.created`, `.granted`, `.rejected`), ids only.
- **Shared types** (the request view, the rule view) under `libs/contracts/<cluster>/`.

## Open design questions

- **Whether approval blocks or compensates.** Blocking is safer and adds latency to every large refund;
  acting immediately and flagging for review keeps the customer happy and means the control is
  detective rather than preventive. For money leaving the business, blocking is the conventional answer.
- **Who the approvers are.** Anyone holding the approval code, a named list, or the requester's
  manager — and the last one requires an organisational hierarchy the system does not have. Staff
  reporting structure is the sort of state a scheduling or HR context would own.
- **Escalation and absence.** A single approver on holiday is an outage of the workflow; automatic
  escalation after a delay is the usual fix and quietly weakens the control it escalates from.
- **Emergency override.** A break-glass path is realistic and is a documented bypass of the control;
  its only honest form is loud, time-boxed and audited more heavily than the thing it bypasses.
- **What a rejected request leaves behind.** The refund did not happen, but the intent and the reason
  are exactly what a later dispute needs, so rejections are retained rather than removed.
- **Whether the captured parameters can go stale.** An order refunded by another path, or partially
  refunded, between request and approval means the captured parameters no longer describe a valid
  action — and the existing idempotency and refund-state checks will refuse it, which is correct but
  produces a confusing failure unless the workflow re-validates first.

## Effort sketch

`2–3 capabilities` — the request aggregate with its state machine and two-person invariant, a
configurable rule set with an expiry sweep, and the operator surface to review and act on a queue. It
stays bounded **because** it wraps existing use cases rather than reimplementing them: the refund path
already requires an idempotency key, already audits unconditionally, and already runs behind a
permission gate, so approval adds a state machine in front and changes nothing inside. The cost that is
easy to miss is not the workflow — it is deciding, per action, what happens to the paths that have no
human actor at all.
