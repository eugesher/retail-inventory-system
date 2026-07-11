# ADR-041: The Nest module file as a first-class composition root

- **Date**: 2026-07-11
- **Status**: Accepted

---

## Context

Every module in every service follows the per-module hexagon ([ADR-004](004-adopt-hexagonal-architecture-per-service.md)) — `domain/`, `application/{ports,use-cases,dto}/`, `infrastructure/`, `presentation/` — and [ADR-017](017-architecture-lint-via-eslint-boundaries.md) encodes the layering, the cross-module isolation, and the cross-service isolation as `eslint-plugin-boundaries` element types. One file per module was never given a home by either decision: the `@Module` file itself.

It drifted into three placements:

| Placement | Count | Who |
| --- | --- | --- |
| `modules/<m>/<m>.module.ts` | 12 | all ten api-gateway modules, catalog, pricing |
| `modules/<m>/infrastructure/<m>.module.ts` | 7 | stock, notifications, retail cart/orders/returns, event-store audit-log/domain-events |
| `modules/<ctx>.module.ts` | 1 | event-store `audit-and-events.module.ts` |

The split is not a service-level policy. The `infrastructure/` placement dates from the May architecture migration (the phases that produced the notification module README still calls the canonical template); the module-root placement began with the June identity and catalog work. Both conventions were being written in the same fortnight — gateway `cart` landed at the module root on 10 June, retail `returns` landed under `infrastructure/` on 19 June. ADR-009's tree and layer table prescribe `infrastructure/<svc>.module.ts` for the gateway, and not one of the gateway's ten modules follows it.

### Why the drift happened

The three placements are not stylistic variants — they are **three different lint regimes**, and only one of them is enforced.

`boundariesElements` matched a file only inside one of the four layer folders. A file at `modules/<m>/<m>.module.ts` therefore matched **no element pattern**, and with `boundaries/no-unknown-files` off it was skipped by `boundaries/dependencies` entirely. The same was true of the module-root `index.ts` barrel. So:

- A module file under `infrastructure/` is typed `infrastructure`: it may reach its own module and the shared libs, and **nothing else**.
- A module file at the module root is typed nothing: **no rule applies to it at all**.

That asymmetry selected for the drift. A Nest module file legitimately imports a *sibling Nest module* — the gateway's `iam` and `customer-admin` admin shells import `AuthModule`, and the event store's context root imports both of its sibling modules. Under the `infrastructure` element type that edge is a cross-module violation. The files that needed it ended up where the linter could not see them, and files that did not need it stayed put. Nobody decided this.

Worse, the barrel blind spot made the isolation rule conditional in a way nobody had stated. A deep cross-module import (`../orders/application/ports`) was rejected; the same reach through the barrel (`../orders`) was accepted. The comment atop `apps/api-gateway/src/modules/auth/index.ts` shows the seam being *used* knowingly — it calls the barrel "the sanctioned cross-module seam" and notes that "the deep `application/use-cases` path is blocked by the boundaries lint". A sanctioned exception that exists only as the absence of a rule is indistinguishable, to the next contributor and to the next agent, from an accident.

## Decision

### 1. The Nest module file is a composition root, and lives at the module root

Uniformly: `apps/*/src/modules/<m>/<m>.module.ts`. The seven files under `infrastructure/` move up one level; the barrel each module already exports through absorbs the change, so no consumer import moves.

The rationale is that the `@Module` file is **not a layer of the hexagon — it is what assembles the hexagon**. It imports `application/use-cases` *and* `infrastructure/persistence` *and* `presentation` in the same breath, because binding the ports to the adapters and the controllers to the use cases is its entire job. A file that sees all four layers does not belong inside one of them.

The repository already reasons this way one level up: `app/app.module.ts` is the app's composition root, sits outside every module, and carries its own element type (`app-bootstrap`). This decision applies the same treatment one level down. Placement is then self-describing — the composition root sits beside the things it composes.

### 2. Three new element types

| Element type | Pattern | Capture |
| --- | --- | --- |
| `shared-module-barrel` | `apps/*/src/modules/auth/index.ts` | `app` |
| `nest-module` | `apps/*/src/modules/*/*.ts` | `app`, `module` |
| `context-root` | `apps/*/src/modules/*.ts` | `app` |

`nest-module` matches the **direct children** of a module folder — `<m>.module.ts` and the module-root `index.ts` barrel. Both are the module's outward face, and typing them is what closes the two blind spots.

`context-root` covers a file directly under `modules/` that composes sibling modules. Only the event store has one, by [ADR-039](039-audit-and-event-store-query-surface.md): `audit-and-events.module.ts` plus the two controllers (`firehose.consumer.ts`, `audit-query.controller.ts`) that inject use cases from **both** sibling modules and so cannot live in either module's `presentation/`. Those two controllers were previously unlinted production files; they now have a rule.

`shared-module-barrel` **must precede `nest-module`** in `boundariesElements` — `auth/index.ts` matches both patterns and the plugin takes the first hit. This is the same ordering hazard ADR-017 §2 flagged for `lib-shim`.

### 3. The rules

- **`nest-module`** reaches every layer of its **own** module, the shared libs, and the `auth` barrel. It may **not** reach a sibling module — neither through a deep path nor through the sibling's barrel.
- **`context-root`** composes sibling module **barrels** and nothing deeper; its lib set is `presentation`'s, because the two files that sit there are controllers. A context root that needs a sibling's internals is a design smell, so there is deliberately no `sameApp` reach into a module's layers.
- **`application-use-case`** and **`presentation`** gain `sameApp('shared-module-barrel')` — see §4.
- **`app-bootstrap`** gains `sameApp('nest-module')`, `sameApp('context-root')`, and `sameApp('shared-module-barrel')`: `app.module.ts` imports each module through its barrel.

The net effect is a **tightening**. Before this decision, *any* file could import *any* sibling module through its barrel with no complaint. Now exactly one cross-module barrel is reachable, and every other cross-module edge — barrel or deep path — fails `yarn lint`.

### 4. The `auth` barrel is the one documented exception (ADR-017 §6)

The gateway's `auth` module owns `StaffUser`, `Customer`, `RoleAggregate`, `PermissionAggregate`, and `ConsentRecord`. The `iam` and `customer-admin` modules are **admin shells** over those same aggregates ([ADR-024](024-rbac-v2-staffuser-customer-and-permissions.md), [ADR-037](037-consent-record-and-tombstone-erasure.md)): they front admin HTTP routes and deliberately reuse auth's repositories and use cases rather than registering a second set of adapters over the same tables. Neither has a `domain/` of its own. `auth.module.ts` exports the repository tokens plus `ReadConsentUseCase` / `EraseCustomerUseCase` precisely so they can.

That seam is real and intentional, and it must not be re-labelled a violation. But it also must not stay invisible. `shared-module-barrel` names it: any gateway module may consume the `auth` barrel; **no other** cross-module barrel is consumable, in any app. ADR-017 §6, which read "No outstanding exceptions", now carries this one — an exception encoded as a lint rule rather than as a hole in one.

The narrow form is the point. Allowing *any* module to consume *any* sibling's barrel would have reproduced today's de-facto behaviour and let a future `cart` → `orders` coupling land silently. Pinning the pattern to `modules/auth/index.ts` means the next cross-module seam is a config change with an ADR behind it, not a diff nobody notices.

### 5. `boundaries/no-unknown-files` is turned on

With the composition roots, the barrels, and the context root all typed, **every** file under `apps/` and `libs/` now claims an element — so the rule that asserts exactly that flips from `off` to `error`.

This is the gate that stops the drift from coming back. The placement drift was possible in the first place because a file could exist outside the taxonomy and no rule would notice; an orphan file is, by construction, a file that none of the other rules can govern. `no-unknown-files` makes creating one fail CI rather than quietly opening a new blind spot. Two fixtures pin it: an orphan is rejected, and `cart.module.ts` is not.

Barrels stay out of the rule's scope as dependency *sources* (a barrel re-exports its own folder and has nothing to violate; the files it re-exports are linted on their own). They are fully in scope as *targets* — which is the whole point of §2.

### 6. Regression fixtures

`spec/architecture-lint.spec.ts` gains six fixtures under `boundaries/dependencies — module composition root (ADR-041)`: a `nest-module` may not reach a sibling through a deep path, nor through its barrel; a use case may not reach a sibling through its barrel; a `nest-module` may wire its own module's use cases; the gateway `auth` barrel *is* reachable from an `iam` use case; a `context-root` may compose sibling barrels. Weakening any of the new rules fails the unit suite.

## Consequences

### Positive

- One placement, everywhere: `modules/<m>/<m>.module.ts`. The question the drift kept re-opening has an answer that `yarn lint` enforces.
- Twelve module files and nineteen module barrels move from "no rule applies" into the dependency graph. Three event-store production files (`audit-and-events.module.ts` and the two context-root controllers) become linted for the first time.
- Cross-module isolation stops being conditional on the import path. Barrel and deep path are now judged the same.
- The `auth` seam is discoverable: it is a named element type with a comment, not a silence.

### Negative

- One more ordering constraint in `boundariesElements` (`shared-module-barrel` before `nest-module`), of the class ADR-017 §2 already warns about.
- `shared-module-barrel` hardcodes a module name in `eslint.config.mjs`. That is the cost of an exception narrow enough to be safe; a generic "barrels are public API" rule would need no name and would buy back the coupling this closes.
- A future module that genuinely needs to compose a sibling `@Module` must widen the config. This is intended friction — but it is friction.

### Open

- The two event-store `context-root` controllers remain outside any module's `presentation/`. ADR-039's reasoning stands; the new element type governs their imports without relocating them.
- `boundaries/no-unknown` (an element importing an *untyped* file) stays off. With every file under `apps/` and `libs/` now typed it has nothing left to catch, so turning it on would be a no-op today — it is worth revisiting only if a future element pattern leaves a gap.

## Alternatives considered

- **Move all twelve module-root files into `infrastructure/`** (what ADR-009 prescribes). Rejected: it types the composition root as an adapter, which makes the `iam` → `AuthModule` edge a violation. It passes lint today only because the import travels through the unlinted barrel — i.e. the uniformity would rest on the very blind spot this ADR exists to close. Closing the barrel hole afterwards would then force either `@Global()` on `AuthModule` (a runtime change to dodge a lint rule) or a widened `infrastructure → infrastructure` edge (which would also let `iam`'s adapters reach auth's adapters).
- **Treat every module-root barrel as the module's public API** — allow any module to import any sibling's barrel, never a deep path. Coherent, and it matches how the `auth` barrel comment already describes itself. Rejected as too permissive for what it buys: it legalises exactly the coupling (`cart` → `orders`) that the cross-module rule exists to prevent, and reviewers would be back to catching it by eye.
- **Refactor `iam` / `customer-admin` to own their ports**, with `auth`'s adapters bound to them in `app.module.ts`. Architecturally the cleanest — no exception at all. Rejected as out of proportion: it reverses ADR-024's deliberate "admin shell over the auth aggregates" design, and the coupling it removes is one module in one app.
- **Hybrid — keep the file in `infrastructure/` but give it a `nest-module` type.** Same lint outcome as the decision, but it leaves the composition root nested inside a layer it is not part of, and adds a second first-match-wins ordering hazard (`infrastructure/*.module.ts` before `infrastructure/**`) for no gain.
- **Document the status quo and move nothing.** Rejected: that is not uniformity, it is a name for the drift, and both blind spots survive.

---

## References

- [ADR-004](004-adopt-hexagonal-architecture-per-service.md) — the per-module hexagon whose layers this file assembles.
- [ADR-009](009-port-adapter-at-the-gateway.md) — prescribed `infrastructure/<svc>.module.ts`; **superseded on that point** by §1 here.
- [ADR-017](017-architecture-lint-via-eslint-boundaries.md) — the element taxonomy extended here; §6 gains its first documented exception.
- [ADR-024](024-rbac-v2-staffuser-customer-and-permissions.md) / [ADR-037](037-consent-record-and-tombstone-erasure.md) — the admin shells whose seam `shared-module-barrel` legitimises.
- [ADR-039](039-audit-and-event-store-query-surface.md) — the event-store context root that `context-root` now types.
