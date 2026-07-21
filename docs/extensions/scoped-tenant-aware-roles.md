---
title: Scoped and tenant-aware roles
cluster: Staff & Access Control
effort: subsystem-scale (5+ capabilities)
attaches_to:
  - apps/api-gateway/src/modules/auth/domain/role.aggregate.ts
  - libs/auth/guards/permissions.guard.ts
  - libs/cache/cache-keys.ts
---

# Scoped and tenant-aware roles

## Description

A **scoped role** is a grant that applies somewhere in particular: this person is a warehouse
supervisor *at the Rotterdam warehouse*, a store manager *of store 42*, an administrator *of the
Acme brand*. A **tenant-aware** system takes the same idea to its limit — every row, every cache entry
and every query is partitioned by an owner, and a subject's authority never crosses the partition.

Today a grant has no *where*. A staff member is bound to a role, that role carries permission codes, and
the codes are inflated into the access token as a flat array. Holding `inventory:adjust` means holding
it at every stock location that exists. The capability described here adds a dimension to the grant.

**The difference from [`dynamic-abac-policies.md`](dynamic-abac-policies.md) is worth being blunt
about, because the two guides both offer to generalise the same guard and only one of them is a data
model.** Scoped roles change the **subject of the sentence**: the grant is now *"`inventory:adjust` at
`rotterdam`"* rather than *"`inventory:adjust`"*. ABAC changes the **verb**: the grant stays what it is,
and a rule decides whether it applies to this particular request. Concretely — a scope is still
decidable from the token alone, because both halves of the comparison are strings the request already
carries. An attribute policy usually is not, because it asks about the *resource*, and finding out
about the resource means loading it. That is why scoped roles fit inside the existing guard and ABAC
does not. They compose rather than compete, and a system that has scoped roles usually discovers it
needed ABAC for a much smaller set of cases than it feared.

The core records multi-tenancy as a deliberate gap with a seam already in place — see
[`README.md` § Not built yet](../../README.md#14-not-built-yet). This guide is what would fill it on the
authorization side.

## Business needs

- **Multi-location retail** — a chain with ten stores wants each manager to run their own store and
  nobody else's. This is the ordinary case, and it arrives with the second location, not the tenth.
- **Franchise and marketplace models** — a franchisee or a marketplace seller must see their own orders,
  their own stock and their own settlement, and must be structurally unable to see a competitor's.
- **Multi-brand operators** — one platform running several storefronts wants staff who work on one brand
  and staff who work across all of them.
- **SaaS deployment economics** — running one instance for many customers is the difference between a
  product and a series of bespoke installations, and tenancy is the precondition.
- **Least privilege at scale** — as staff headcount grows, an unscoped grant becomes the thing that
  turns a small compromise into a large one.
- The threshold: a single-location shop needs none of it, and adding it speculatively taxes every query
  in the system. The second physical location, or the first customer who is not you, is the trigger.

## Attachment points in the current core

- **`RoleAggregate` at `apps/api-gateway/src/modules/auth/domain/role.aggregate.ts` — a role has a name
  and a set of codes, and nothing else.** No owner, no scope, no applicability. The `staff_user_roles`
  join is a bare `(staff_user_id, role_id)` pair, so **the grant is exactly two columns wide and a scope
  has nowhere to live.** Widening that tuple is the smallest change that makes the capability possible
  and the one that ripples furthest.
- **`PermissionsGuard` and `enforceRequiredClaim` at `libs/auth/guards/` — a synchronous set
  membership test.** The shared helper reads the route's required codes, returns `true` when a route
  declares none, and otherwise requires `request.user`'s claim array to contain **at least one** of
  them. Two consequences a sketch must respect: the test is *disjunctive* — two codes on one route means
  "either" — and it never awaits anything. A scope check that compares two strings both already present
  in the request keeps that property. A scope check that has to look up which store an order belongs to
  does not, and belongs elsewhere.
- **The permission-code regex, which quietly forbids the cheap implementation.**
  `PermissionAggregate` enforces `^[a-z][a-z-]*:[a-z][a-z-]*$` — lowercase letters and hyphens either
  side of one colon, and the invariant lives in the domain expressly so it holds even for codes built
  from non-enum strings. So `inventory:adjust@rotterdam`, `inventory:adjust:store-7` and
  `inventory:adjust-42` are all rejected: **a scope cannot be smuggled into the code string.** That is a
  gift rather than an obstacle — the tempting shortcut is exactly the design that makes
  `PermissionCodeEnum` stop being an enumerable registry, and the model refuses it up front.
- **The access-token claim shape.** `IJwtAccessPayload` carries `sub`, `email`, `roles`,
  `permissions: string[]` and a `jti`; `ICurrentUser` — what every guard and every
  `@CurrentUser()`-injecting use case sees — is `{ id, email, roles, permissions }`. Neither has a place
  for a scope. `LoginUseCase` and `RefreshTokenUseCase` inflate the claim identically from
  `StaffUser.permissionCodes`, and [ADR-024](../adr/024-rbac-v2-staffuser-customer-and-permissions.md)
  is explicit that the token's lifetime is the staleness window for any change to it.
- **`CACHE_KEYS` at `libs/cache/cache-keys.ts` — the one part of the system already built for this.**
  Every key is `ris:[t:<tenantId>:]<service>:<aggregate>:<version>:<id>[:<facet>]`. The tenant segment
  is **opt-in and omitted entirely when absent** rather than defaulted to a placeholder, so a
  single-tenant key carries no tenant-shaped lie, and it sits near the root so a per-tenant sweep is a
  tight prefix scan. No key literal exists anywhere in `apps/`, so adopting the segment is a change to
  the builders' callers, not a hunt through string concatenation.
- **`StockLocation` already has a caller-assigned string primary key**, which makes it the most natural
  first scope in the system — a warehouse scope needs no new identifier scheme, only a decision that the
  identifier means something to authorization.
- **The audit trail is scope-blind today.** `IAuditLogEvent` carries an actor, a target and a free-form
  payload; there is no tenant field, and a scoped deployment's first compliance question is "show me
  everything that happened in this tenant".

## Implementation sketch

- **Decide the scope *type* first, and resist making it free-form.** A scope is a location, a store, a
  brand or a tenant — a small, closed set of dimensions. "Any string is a scope" is briefly easier and
  produces an authorization model nobody can enumerate, audit or test.
- **Widen the grant, not the code.** `staff_user_roles` becomes `(staffUserId, roleId, scopeType,
  scopeId)`, with a null scope meaning global. The permission vocabulary is untouched, which keeps the
  enum, the seed, every existing `@RequiresPermission` call site and the seeded role bundles valid.
- **Carry resolved scopes in the token, and keep the claim small.** The natural shape is a scope-keyed
  map from scope to codes, plus the global set. The token is already the guard's only input and must
  stay so; the risk is size, since a subject scoped to fifty stores has a token that is mostly
  authorization data. Interning codes, or carrying scopes and resolving bundles per request, are the
  two ways out and they trade size against a database read.
- **Extend `ICurrentUser` once.** Every downstream use case folds `@CurrentUser()` into its command
  already, so the scope arrives wherever a decision is made without a new plumbing seam — but it is a
  change to a contract that the whole gateway depends on, and it is best made in one edit rather than
  per module.
- **The guard checks what the request already carries; the use case checks what it has to load.** A
  route whose scope is in the path or a header is decidable in the guard with the existing synchronous
  comparison. A route whose scope is a property of the record being modified is not — the record has to
  be read, and reading it belongs in the use case, which then rejects with the module's own domain
  error. Pretending otherwise is how a guard grows a repository dependency and stops being a guard.
- **Adopt the cache tenant segment at the same time, or not at all.** A scoped authorization model over
  an unscoped cache is a cross-tenant read waiting to happen: the guard says no and the cache says here
  you are. The builders take the segment already; the work is threading a tenant through every call
  site and being certain none was missed.
- **Partition the data, then decide how.** A shared schema with a discriminator column on every table
  is the cheapest and leans entirely on every query being correctly filtered — one missing `WHERE` is a
  cross-tenant leak. Schema- or database-per-tenant is stronger and multiplies migration and connection
  management. This choice is more consequential than anything in the authorization model, and it is not
  reversible in practice.
- **Scope every audit row and every event.** A scoped system's audit log has to answer per-scope
  questions, so the scope joins the event payload — as an identifier, never as PII
  ([ADR-037](../adr/037-consent-record-and-tombstone-erasure.md)).
- **Events** keep their dotted keys on `ris.events`; a tenant identifier travels in the payload rather
  than in the routing key, so no consumer's binding has to change.
- **Shared types** (the scope value object, the scoped-grant view) under `libs/contracts/<cluster>/`.

## Open design questions

- **Whether scopes nest.** A region containing stores, a brand containing storefronts: hierarchy makes
  grants expressive and makes every check a tree walk. The materialized-path pattern the category tree
  uses is the shape precedent, and adopting it is a decision, not a detail.
- **Token size versus a per-request read.** The whole benefit of the current design is that a guard
  costs nothing beyond reading a claim. A subject with many scopes threatens that, and the alternative
  — resolving scopes per request — reintroduces the database hit the JWT inflation exists to avoid.
- **How a scoped grant is revoked in time.** Permission changes already take effect on the next
  refresh, not immediately; a scope revocation inherits that window, and in a franchise setting that
  window is the one an auditor asks about.
- **Cross-scope operations.** A transfer between two warehouses, an order fulfilled from another
  store's stock, a report spanning brands — every one needs a grant in two places at once, or an
  explicit cross-scope code, and neither is obviously right.
- **What tenancy does to the shared identity space.** One directory of staff across tenants makes
  cross-tenant staff possible and cross-tenant leakage possible; a directory per tenant duplicates
  people who genuinely work in several.
- **Whether customers are tenanted too.** Scoping staff is tractable; scoping the customer-facing side
  means every catalog read, cart and order carries a partition, which is a far larger change than the
  authorization model that motivated it.

## Effort sketch

`subsystem-scale (5+ capabilities)` — a scope model, a widened grant with its administrative surface, a
token-shape change, guard and use-case enforcement, cache-key tenanting, data partitioning, and audit
scoping. It is bounded by exactly two pieces of existing groundwork: the cache-key convention already
reserves a tenant segment and forbids key literals in application code, and the permission registry
survives untouched because the scope goes on the grant rather than into the code string. Everything
else is genuinely new, and the reason this is subsystem-scale rather than merely large is that a
partial rollout is worse than none — a system where nine of ten read paths are scoped is a system with
one leak and a false sense of safety.
