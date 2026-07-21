---
title: Staff scheduling and shifts
cluster: Staff & Access Control
effort: subsystem-scale (5+ capabilities)
attaches_to:
  - apps/api-gateway/src/modules/auth/domain/staff-user.model.ts
  - apps/notification-microservice/
---

# Staff scheduling and shifts

## Description

**Staff scheduling** is workforce management: who works which shift at which location, who is available
when, who clocked in, who is absent, and whether the resulting roster satisfies labour rules and a
budget. Every retail chain of any size runs one, and most run it in a separate product bolted to the
till.

This is the guide in this cluster that is **least** an extension of the core and most a neighbouring
system that happens to share a directory of people. Everything else here modifies how authorisation
works; this modifies nothing, and instead builds a bounded context that **references** the staff
identity without extending it.

That distinction is the whole design, and it rests on what `StaffUser` actually is. It is an
authentication principal: an email, a password hash, a set of roles, an `active | suspended` status, a
last-login timestamp and a refresh-token hash. **It carries no person** — no legal name, no employment
dates, no contract hours, no home location, no manager. A scheduling context needs all of those, and
the temptation is to add them to the aggregate that already exists. Resisting that is the correct call:
authentication and employment have different lifecycles (a contractor's account is disabled the day
their access ends; their employment record outlives it for years of payroll and tax retention),
different consumers, and — most decisively — very different privacy obligations. An employment record
is dense personal data; an authentication principal is deliberately not.

## Business needs

- **Labour is the largest controllable cost in retail**, and scheduling to forecast demand rather than
  to habit is where it is controlled.
- **Coverage is an operational requirement** — a store that opens without a keyholder, or a warehouse
  with nobody trained on returns during a peak, is a direct revenue loss.
- **Legal compliance is not optional** — maximum hours, mandatory rest between shifts, break
  entitlements and predictive-scheduling laws carry real penalties and vary by jurisdiction.
- **Payroll needs hours** — worked time has to reach a payroll system accurately, and the reconciliation
  between rostered and actual hours is where disputes live.
- **Staff expect self-service** — seeing a roster, requesting time off and swapping a shift from a phone
  is the baseline experience, and its absence generates a stream of manual work for managers.
- The threshold: a shop where the owner and one assistant agree hours in a message needs nothing. The
  first location with a rota pinned to a wall is where a system starts paying, and multiple locations is
  where it becomes unavoidable.

## Attachment points in the current core

- **`StaffUser` at `apps/api-gateway/src/modules/auth/domain/staff-user.model.ts` — the identity a
  scheduling context references, and the boundary it must not cross.** It exposes `email`, `roles`,
  `roleNames`, `permissionCodes`, `status`, `lastLoginAt` and `isActive`. Its `toJSON` deliberately
  redacts the password and refresh hashes, because structured logging and response serialisation are
  the most common accidental egress in a Nest handler — the same care an employment record needs and
  more of it. A scheduling context stores a `staffUserId` and nothing else about the person's identity.
- **`status: 'active' | 'suspended'` is an *access* state, not an employment state.** A suspended
  account may belong to someone on parental leave, someone who left, or someone whose password was
  compromised this morning; a scheduling context needs to tell those apart and cannot. `suspend()`
  additionally has no production caller today — the staff-deactivation gap the root
  [`README.md` § Not built yet](../../README.md#14-not-built-yet) records — so even the access state is
  not yet driven by anything an operator does.
- **`StockLocation` carries a caller-assigned string primary key**, which makes it the natural anchor
  for "where a shift happens" without inventing a second location scheme. That shared anchor is also
  what makes this context and
  [`scoped-tenant-aware-roles.md`](scoped-tenant-aware-roles.md) natural neighbours: one decides where a
  person is *rostered*, the other where they are *authorised*, and a mature deployment eventually wants
  the first to inform the second.
- **The six existing deployables are the template for a seventh.** Each is `apps/<name>/` with per-module
  hexagonal layers, the Nest module file as the module's composition root, RabbitMQ as the transport,
  its own queue, and a `main.ts` whose **first import is the tracer** — auto-instrumentation patches at
  module load, so anything required before it is invisible to tracing. The notification service is the
  canonical layout to copy.
- **The notification pipeline takes shift reminders unchanged.** A roster-published or shift-reminder
  message is a new template keyed on its event type and channel, dispatched by a consumer that — like
  every consumer in the system — **never rethrows**, because an exception out of an event handler makes
  the broker redeliver in a hot loop. Staff operational mail is transactional by its event type, so the
  marketing consent gate is not in play.
- **The audit seam takes roster changes** as event names — `ShiftAssigned`, `TimeOffApproved` — never
  permission codes, and with ids rather than personal detail in the payload.
- **The UTC discipline the persistence layer already enforces.** The driver is pinned to UTC, and a
  zone-less date string resolves in the Node host's local zone rather than in UTC — a bug this
  repository already guards against at several boundaries. Scheduling is the domain where that bites
  hardest, because a shift is a wall-clock fact in a store's local zone and a stored instant is not.

## Implementation sketch

- **A new deployable, `apps/staff-scheduling-microservice/`**, with its own queue and the standard
  layered layout. It is a new deployable rather than a gateway module because it is a genuinely separate
  bounded context: different aggregates, a different lifecycle, its own retention rules, and no shared
  aggregate with the core — only a referenced identifier.
- **Its own database, following the precedent the event store set.** Employment data has a different
  retention regime, a different sensitivity class and a different set of people who may read it than
  operational retail data. Isolation is easier to establish at the start than to retrofit, and the
  system already runs two logical databases for a comparable reason.
- **An `Employee` aggregate, separate from `StaffUser`**, holding employment facts and a
  `staffUserId` reference. **Not a foreign key** across the database boundary: the two contexts are
  independently deployable and the reference is a value, resolved by id. The mapping is
  one-to-at-most-one in both directions and neither side owns the other's lifecycle.
- **Core aggregates**: `Shift` (location, time window, required role or skill), `ShiftAssignment`
  (employee, shift, state), `Availability` (recurring and exceptional), `TimeOffRequest` (with an
  approval lifecycle that is the same shape [`approval-workflows.md`](approval-workflows.md) describes),
  and `TimeEntry` (clock in/out, the record payroll reconciles against).
- **Store instants in UTC and keep the location's zone beside them.** A shift is authored as "Tuesday
  06:00 at Rotterdam" and that is not an instant until the zone is applied; storing the rendered instant
  alone loses the fact across a daylight-saving boundary, which is precisely when rosters go wrong.
- **Roles are the skill vocabulary, not a new one.** "This shift needs someone who can receive returns"
  is already expressible: `warehouse-staff` bundles `inventory:receive-return`. Reusing the permission
  vocabulary for shift requirements keeps one registry instead of two that drift, and it means a
  rostering rule can be checked against what a person can actually do in the system.
- **Employment data is the densest personal data in the system, and it is governed accordingly.** Legal
  names, contact details, contract terms and absence records — the last of which can imply health
  information — stay in this context's own store. They do **not** enter event payloads and they do
  **not** enter audit rows, which is the standing rule for the durable, replicated logs
  ([ADR-037](../adr/037-consent-record-and-tombstone-erasure.md)). A roster event carries a shift id and
  an employee id; a notification is rendered from data read at dispatch, not from data carried on the
  wire. Retention here is driven by employment law rather than by product preference, so a general
  "erase on request" is the wrong default and a documented schedule is the right one.
- **Labour rules as configuration, evaluated on publish.** Maximum consecutive days, minimum rest,
  break entitlements — jurisdiction-specific, changing, and wrong to bury in code. A validation pass
  when a roster is published, with explicit violations rather than silent refusal.
- **Events** ride `ris.events` with dotted keys (`scheduling.shift.assigned`,
  `scheduling.timeoff.approved`) on the one live exchange — no second broker and no second exchange —
  and carry ids only.
- **Payroll export is an outbound integration**, and it is the direction where a scheduled document
  leaves the system; it belongs behind a port with an adapter per provider, not inline in a use case.
- **Shared types** (shift, assignment and availability views) under `libs/contracts/<cluster>/`.

## Open design questions

- **Build or buy — and the honest default is buy.** Mature workforce-management products exist, are
  cheap relative to the build, and already encode jurisdiction-specific labour rules that are a
  standing maintenance obligation. The case for building is a tight loop between rostering and the
  operational data this system already holds — demand forecasts, fulfilment volumes, till coverage — and
  that case has to be made rather than assumed.
- **Where the `Employee`↔`StaffUser` link is authoritative.** Hiring someone in the scheduling context
  and provisioning an account are two acts; automating either direction couples the contexts, and
  leaving both manual guarantees they diverge.
- **Whether a shift should affect authorisation.** "Only permit stock adjustments during a rostered
  shift" is a real control and a real lockout risk, and it is an attribute policy — a condition on a
  grant rather than a grant — which is [`dynamic-abac-policies.md`](dynamic-abac-policies.md)'s subject
  rather than this one's.
- **Shift swaps and open-shift claiming** are the features staff want most and are a small marketplace,
  with its own concurrency question: two people claiming one shift is a compare-and-swap, not a
  read-then-write.
- **How far to go into time and attendance.** A clock-in is a small feature; a clock-in that payroll
  trusts needs an anti-fraud posture — location checks, supervisor sign-off — and location checks are
  another tracking obligation.
- **Whether demand forecasting is in scope at all.** Scheduling to forecast is where the cost savings
  are, and forecasting is an independent capability that happens to consume this one's output.

## Effort sketch

`subsystem-scale (5+ capabilities)` — a new deployable with its own store, an employment record, shift
and assignment modelling, availability and time-off with approvals, time and attendance, labour-rule
validation, and self-service plus manager surfaces. Almost nothing is inherited: the transport, the
layered layout, the notification pipeline and the audit seam are reused, but every aggregate is new and
the domain is genuinely intricate — recurring patterns, timezone-correct wall-clock scheduling,
jurisdictional rules and the reconciliation between rostered and worked hours. It is included here
because it is a real and frequently requested retail capability, and the most valuable thing this sketch
records is where its boundary sits: it references the staff identity, and it does not extend it.
