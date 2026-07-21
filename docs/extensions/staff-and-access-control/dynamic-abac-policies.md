---
title: Dynamic ABAC policies
cluster: Staff & Access Control
effort: subsystem-scale (5+ capabilities)
attaches_to:
  - libs/auth/guards/claim-guard.util.ts
  - libs/auth/decorators/requires-permission.decorator.ts
  - libs/contracts/auth/permission.enum.ts
---

# Dynamic ABAC policies

## Description

**Attribute-based access control** replaces a fixed grant with an evaluated rule. Instead of *"this
subject holds `order:refund`"*, the question becomes *"may this subject refund **this** order, given
that it is worth €4,000, was placed by a customer flagged for review, and it is 03:00 on a Sunday?"* —
answered by a policy that reads attributes of the subject, the resource, the action and the environment,
and that an administrator can change without a deployment.

**This is a different generalisation from
[`scoped-tenant-aware-roles.md`](scoped-tenant-aware-roles.md), and that guide states the split from the
grant side; here it is from the decision side.** Scoped roles keep the decision procedure — a set
membership test — and enrich what is in the set. ABAC keeps the grants and replaces the procedure with
an evaluation. The practical consequence is the one that decides whether a project needs both: a scope
comparison is answerable from the request and the token, and an attribute policy usually is not,
because the interesting attributes belong to a resource nobody has loaded yet. Neither subsumes the
other, and the honest ordering is that scoped roles are worth doing first — most real requirements that
sound like policies ("managers can only refund their own store's orders") are scope requirements
wearing a policy's clothes.

The permission registry is what this capability would displace at the centre of the model, and it is
worth being precise about how much of it: the codes remain the vocabulary of *actions*. What stops
being the whole answer is the idea that holding a code is the same thing as being allowed.

## Business needs

- **Rules that change faster than releases** — an approval threshold, a temporary freeze on a category,
  a seasonal restriction. Each is a policy edit in an ABAC system and a code change plus a deployment
  without one.
- **Conditions no role can express** — value limits, time-of-day windows, ownership of the specific
  record, a customer's risk flag. A role either has the code or does not; it cannot have it *up to
  €500*.
- **Delegation and temporary access** — covering a colleague's shift, or granting an auditor read
  access for a week, are naturally expressed as policies with an expiry and awkwardly expressed as
  roles someone has to remember to revoke.
- **Regulatory data-access rules** — restricting who may read customer records to those with a current
  business reason is an attribute question by construction.
- **Explainability** — a policy engine can say *why* a request was denied, which a boolean guard cannot,
  and which support teams ask for constantly.
- The threshold: a shop whose rules fit in role names does not need this and will pay for it in every
  request. The first requirement that contains the word "unless", or a number, is the signal.

## Attachment points in the current core

- **`enforceRequiredClaim` at `libs/auth/guards/claim-guard.util.ts` — the entire decision procedure,
  and its shape is the constraint.** It reads the route's required values, lets a route declaring none
  through, and demands the subject's claim array contain **at least one** of them. It is **synchronous,
  pure, and reads only `request.user`** — no repository, no `await`, no request body. Every property a
  policy engine needs, it lacks: it cannot load a resource, it cannot be async, and it sees the route's
  metadata rather than the route's arguments. Extracted deliberately so `RolesGuard` and
  `PermissionsGuard` cannot drift apart, it is one function and therefore one place to change — but
  changing it changes both gates at once, which is a feature when the change is right and the reason to
  be careful when it is not.
- **`@RequiresPermission` at `libs/auth/decorators/requires-permission.decorator.ts` — thinner than it
  looks.** It is a bare `SetMetadata` of a string array, resolved with `getAllAndOverride` over
  `[handler, class]`. Two facts a policy sketch must not get wrong: the decorator carries **no**
  resource reference, so the metadata cannot name what is being acted on; and handler metadata
  **overrides** class metadata rather than merging with it, so a class-level requirement is silently
  discarded on any method that declares its own. A policy decorator inherits both behaviours unless it
  deliberately does not.
- **`PermissionCodeEnum` at `libs/contracts/auth/permission.enum.ts` — the registry, and what survives.**
  It is the single compile-time-checked source of truth: `@RequiresPermission` call sites reference its
  members, `PERMISSION_SEEDS` mirrors every one of them, and the seeded `admin` role is literally
  `Object.values(PermissionCodeEnum)`. **Keep it as the action vocabulary.** A policy still has to name
  what is being attempted, and a closed, exhaustively seeded enum is a far better answer than
  free-text action strings — which is also why a policy engine that invents its own action namespace
  ends up with two registries that disagree.
- **The three global guards, in a fixed order.** `JwtAuthGuard → RolesGuard → PermissionsGuard`, wired
  as `APP_GUARD` providers; `@Public()` short-circuits the first, and the other two pass a public route
  because it declares no metadata for them to read. A policy gate is a **fourth** stage after the
  existing three, not a replacement for them: authentication still has to happen first, and the coarse
  gates are a cheap pre-filter that keeps the expensive evaluation off requests that were never going
  to be allowed.
- **Gateway use cases already fold `@CurrentUser()` into the command.** That means the subject's
  attributes are available at the exact point where the resource is also available — which is the point
  where a resource-attribute policy can actually be evaluated, and it is inside the use case, not in
  front of it.
- **`ICurrentUser` is `{ id, email, roles, permissions }`.** It is the complete set of subject
  attributes the system currently has. Everything else a policy might want about a person — department,
  manager, employment status, location — does not exist yet.

## Implementation sketch

- **Split enforcement in two, by whether the resource has to be loaded.** Policies over the subject, the
  action and the environment stay in the guard chain as a fourth stage. Policies over the resource move
  into the use case, immediately after it loads the aggregate and before it mutates anything. This is
  the load-bearing decision of the whole sketch: attempting resource policies in a guard forces either a
  repository dependency in `libs/auth` or a second load of the same record, and both are worse than
  admitting the split.
- **A `Policy` aggregate**: target action (a `PermissionCodeEnum` member), a condition expression, an
  effect, a priority and an active flag. Store the condition as structured data — a small typed
  expression tree — not as an embedded scripting language. An engine that evaluates arbitrary code
  supplied by an administrator is a remote-code-execution surface with an approval workflow in front
  of it.
- **`deny` overrides `allow`, always, and the default is deny.** These are the two rules every mature
  policy system converges on, and both are far easier to adopt at the start than to retrofit once
  policies exist that quietly depend on the opposite.
- **Attributes come from a resolver per attribute source**, so a policy that needs an order's total
  does not entitle the engine to a repository. The resolver set is the real boundary of what policies
  can express, and keeping it small and explicit is what keeps the system analysable.
- **Cache decisions carefully or not at all.** Policy evaluation on a hot path is a latency
  question, and a decision cached on a key that omits one input is an authorization bug that only
  appears under load. If decisions are cached, they go through a `CACHE_KEYS` builder with its own
  version segment like every other key in the system, so a policy-shape change re-keys the whole set in
  one edit.
- **Every evaluation is auditable, and denials especially.** The audit `action` is an event name —
  `PolicyDenied`, `PolicyEvaluated` — never a permission code; the payload carries the policy id, the
  action and the decision, and no personal data
  ([ADR-037](../../adr/037-consent-record-and-tombstone-erasure.md)).
- **Editing policies is itself a gated action**, behind its own permission code — and a code is not
  live until it is also seeded, otherwise it reaches no role at all, `admin` included. Anyone who can
  write policies can write themselves an allow, so this is the highest privilege in the system and a
  natural first gate for an approval workflow.
- **Ship a simulator before shipping enforcement.** "Would this policy have allowed yesterday's
  requests?" is the only way to change an authorization model without discovering the answer in
  production.
- **Shared types** (the policy view, the decision result with its reason) under
  `libs/contracts/<cluster>/`.

## Open design questions

- **Whether to adopt an existing engine.** A standard policy language brings a mature evaluator, tooling
  and a body of practice, at the cost of an external dependency on the authorization hot path and a
  second language in the codebase. Rolling a small typed expression evaluator keeps everything in one
  place and is a decision to maintain an authorization engine.
- **Where the fourth gate goes.** After `PermissionsGuard` is the obvious answer; whether the coarse
  code check should still be able to *deny* on its own, once a policy could have allowed, is not — and
  the two orderings give different answers for the same request.
- **How a denial explains itself without leaking.** "Denied by policy 7 because the order exceeds your
  limit" is what support needs; it is also a description of the security model handed to whoever asked.
- **Performance under composition.** Every request evaluating every applicable policy against resolved
  attributes is a cost multiplied by traffic, and the natural mitigation — indexing policies by action —
  works only while conditions stay simple.
- **Testing an editable authorization model.** Once rules are data, the test suite can no longer
  enumerate the system's behaviour, and the guarantee degrades from "proven" to "simulated".
- **Whether this is needed at all after scoping.** Genuinely open, and worth answering before starting:
  if the requirements that motivated ABAC are all of the form "their own store", the scoped-grant model
  delivers them at a fraction of the cost and without making authorization dynamic.

## Effort sketch

`subsystem-scale (5+ capabilities)` — a policy model and its expression language, an evaluator, an
attribute-resolver framework, guard-side and use-case-side enforcement, an administrative surface with
simulation, and audit of every decision. Reuse is thinner here than anywhere else in this cluster: the
permission enum survives as the action vocabulary and the guard chain survives as the pre-filter, but
the decision procedure is replaced rather than extended. The cost that is systematically underestimated
is not building the engine — it is that authorization stops being a property of the code and becomes a
property of the data, so every question about who can do what becomes a query rather than a read of the
source.
