# ADR-047: Staff-user creation over HTTP, and its own permission code

- **Date**: 2026-07-12
- **Status**: Accepted

---

## Context

A sweep of the DI graph across `apps/` — the one class of dead code no off-the-shelf tool finds, because Nest wires by token rather than by import — came back almost clean:

| | registered | with no consumer |
| --- | --- | --- |
| DI tokens | 73 | **0** |
| Port tokens declared in `application/ports/` | 71 | **0** unbound |
| Class providers | 165 | **1** |

The one was `RegisterStaffUserUseCase`. It is written, unit-tested, registered as a provider, and exported from `auth.module.ts` — and **no controller injects it**. There is no `POST /auth/staff/register`, no RPC, no consumer of any kind. The only way to mint a staff principal was `scripts/test-db-seed.ts`.

That is not dead code to delete. It is the **seam for a capability that is genuinely missing**: a system whose IAM surface can create roles and assign them to staff, but cannot create the staff, is incomplete. `README.md` §14 keeps a `Gap | Seam that exists` table for exactly this shape of thing — and this gap was not in it, because nobody had noticed.

Two smaller findings came out of the same sweep, and one of them was a trap:

- `AUTH_USER_VALIDATOR` and `ValidateJwtSubjectUseCase` sat in `authLibDynamicModule`'s `exports` with nothing outside consuming them.
- `CUSTOMER_REPOSITORY` **looked** like the same thing and is not. Removing it broke the gateway's boot — see §3.

## Decision

### 1. `POST /api/iam/staff`

The route lands in `modules/iam/`, the admin shell over the auth aggregates, next to role creation and role assignment. `IamController` injects `RegisterStaffUserUseCase` through the `auth` barrel — the sanctioned cross-module seam the admin shells already use (`ARCH-LINT-EX-02`, ADR-024). The `StaffUser` aggregate stays in the module that owns it; IAM is the surface, not the owner.

`roleNames` is required and non-empty. A staff user with no role is a principal that can authenticate and do nothing — a worse outcome than a rejected request, and the use case already enforced it.

The use case needed one change to be reachable: it was exported from `auth.module.ts` (so DI could see it) but **not from `modules/auth/index.ts`** (so TypeScript could not). The two exports are different things, and it had only one of them — which is a large part of why it went unnoticed.

### 2. A new permission code: `iam:staff-create`

**Not** `iam:assign`. Minting a principal is a strictly higher privilege than granting an existing one a role bundle: a shared code would make role assignment a silent user-creation escalation. `iam:role-edit` is likewise about the role catalogue, not about people.

Per the standing rule, the new `PermissionCodeEnum` member also goes into `PERMISSION_SEEDS` in `scripts/test-db-seed.ts` — otherwise it exists in the enum and reaches no role, including `admin`, whose seed is `Object.values(PermissionCodeEnum)`.

### 3. `authLibDynamicModule` exports what is actually consumed — which is more than it looked like

`AUTH_USER_VALIDATOR` and `ValidateJwtSubjectUseCase` are removed: `libs/auth`'s `JwtStrategy` resolves the validator from `providers` **inside the same dynamic module**, and nothing else consumed either.

`CUSTOMER_REPOSITORY` **stays**, and the reason is the interesting one. Static analysis said it had no consumer outside its own directory, and that was true — and irrelevant. Its **provider** lives inside the dynamic `AuthLibModule`, while its eight consumers (`Login`, `Logout`, `RegisterCustomer`, `RefreshToken`, `EraseCustomer`, …) are `AuthModule`'s own use cases. **Those are two different Nest modules that happen to share a directory.** Without the export, the whole gateway fails to boot.

The lesson generalises: **a DI boundary is a module, not a folder.** A static check that reasons about file paths will get this class of question wrong, and the only thing that caught it was booting the app — which is why the e2e suite runs on every DI change.

## Consequences

### Positive

- The IAM admin surface is coherent: it can create a role, create a staff user, and bind them. Before, a real deployment could not add a second administrator without shell access to the database.
- A use case that had been paid for — written, reviewed, unit-tested — becomes reachable instead of being deleted.
- The DI graph now has **zero** unreachable providers.
- The e2e proves the thing that matters, which is not the `201`: the created user **logs in**, and its token carries the role's permissions and not an empty bundle. A `201` only proves a row was written.

### Negative

- One more permission code to seed and to reason about. That is the price of not conflating "can grant a role" with "can create a person".

### Open

- No staff **deactivation** or password-reset route. `StaffUser` has a `status` and the aggregate can suspend, but nothing calls it — the same shape of gap this ADR just closed, one aggregate over. It is recorded in `README.md` §14 rather than fixed here.

## Alternatives considered

- **Delete `RegisterStaffUserUseCase`.** The orthodox "dead code goes" answer, and wrong here: it would throw away a working implementation of a capability the system genuinely lacks, and leave the gap.
- **Gate it on `iam:assign`.** Simpler, one fewer code — and it silently upgrades every role-assigner into a user-creator. Rejected on that alone.
- **Put the route in `modules/auth/`** beside customer registration. Rejected: `auth/` is the aggregate owner and the authentication surface; administration of staff belongs with the other staff administration, in `iam/`. The admin-shell pattern (ADR-024) exists for exactly this.
- **Leave it unwired and record the gap in §14.** Honest, and cheap — but the seam and the implementation both already existed, so the remaining work was a controller and a DTO.

---

## References

- [ADR-024](024-rbac-v2-staffuser-customer-and-permissions.md) — the `StaffUser` / `Role` / `Permission` model and the admin-shell pattern this route joins.
- [ADR-010](010-jwt-rbac-at-the-gateway.md) — the guard chain the new code is gated by.
- [ADR-046](046-libs-layout-and-dead-export-removal.md) — the previous dead-export sweep, one level up in `libs/`.
