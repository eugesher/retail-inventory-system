# ADR-050: The alias that was born deprecated

- **Date**: 2026-07-12
- **Status**: Accepted

---

## Context

`StaffLoginController` was declared `@Controller(['auth', 'auth/staff'])` — Nest's multi-prefix
form, which mounts one handler at two URLs. It served `POST /api/auth/staff/login` and
`POST /api/auth/login`, and a comment above it explained the second:

```ts
// Multi-prefix: `/auth/login` is the deprecated alias kept for one release
// (the old route kept as a deprecated alias); `/auth/staff/login` is the
// new canonical path.
```

Both halves of that sentence are false, and `git` says so in one command.

**It was never old.** `git show d3035ad` — *RIS-46 Baseline identity*, the commit that
introduced staff login at all — already contains the decorator above, both URLs, and the comment
calling one of them the *old* route. There was no previous release, no prior URL, and no client
that had ever seen a different path. **The alias was back-compat with a past that did not
exist.** Nobody was ever asked to migrate off anything, because there was nothing to migrate
off.

**"One release" was eleven epics ago.** The deprecation named its own expiry and nothing
checked it. This is [ADR-046](046-libs-layout-and-dead-export-removal.md)'s `CacheHelper`
exactly: *a deletion queued behind a condition, with no owner and no check, is not queued — it
is forgotten.* There the condition was a cache-key version bump (it happened three times).
Here it was "one release" (there have been eleven).

### The alias was not idle, which is the part that had to be checked first

`/auth/login` had **seven** live callers inside the repo — `auth`, `auth-customer`, `catalog`,
`catalog-categories`, `catalog-media`, `iam` and `event-store-audit-log` e2e specs all
bootstrapped their admin token through it, presumably because it is the shorter URL to type.
So this is *not* a dead-code removal in the sense of ADR-046/048/049: the route had traffic. It
is a **contract** removal, and it is safe for a different reason — every one of those callers is
ours, and the route they should have been calling produces a byte-identical response from the
same `LoginUseCase`.

The canonical path, meanwhile, is what all 45 other e2e specs and every `http/kulala/*.http`
scenario already use.

### The landmine this filed itself under

The instruction that opened this work was *"delete the deprecated method
`POST /auth/login` (`staff-login.controller.ts`)"* — file named, intent unambiguous. Executing
it literally would have deleted **the file**, and the file is not the deprecated method: it is
*both* routes. `rm` would have taken `/api/auth/staff/login` with it — the entry point to the
whole JWT chain, used by 45 e2e suites and every `.http` file. **Staff authentication would
have been removed from the system**, and it would have compiled, linted and built cleanly on
the way out.

A multi-prefix `@Controller([...])` is the only construct in this repo where deleting a route
and deleting the file that contains it are different operations. It is now a landmine entry.

## Decision

### 1. `@Controller(['auth', 'auth/staff'])` → `@Controller('auth/staff')`

The class, the handler, the use case and the DTOs are untouched; one element leaves an array.
`AuthController` is `@Controller('auth')` and owns `refresh` / `logout` / `me` — subject-kind
agnostic routes that never had a `login`, so nothing is orphaned and nothing collides.

The comment is rewritten to say what happened rather than what was imagined.

### 2. The seven internal callers move to the canonical path

A mechanical swap in the seven e2e specs. Nothing is asserted differently: it is the same
handler, the same body, the same response.

### 3. The test that defended the alias now defends its absence

`auth-customer.e2e-spec.ts` carried *"POST /api/auth/login (deprecated alias) still returns
200"*. It is inverted, not deleted — the route must now **404**:

```ts
it('POST /api/auth/login (the removed alias) is gone', async () => {
  const { status } = await supertest(apiGatewayApp.getHttpServer())
    .post('/api/auth/login')
    .send({ email: 'admin@example.com', password: 'admin1234' });

  expect(status).toBe(HttpStatus.NOT_FOUND);
});
```

Removing a route without pinning its absence leaves the deletion unguarded: a future
`@Controller(['auth', ...])` would resurrect it in silence, and no other test in the suite would
notice. This is the same move [ADR-049](049-the-port-methods-nothing-calls.md) made on the nine
stock-cache tests — a test that asserts the behaviour the design has ruled out is defending the
wrong thing.

### 4. The callers a type-filtered search cannot see

The first sweep for callers ran as `grep -rn "auth/login" --include=*.ts --include=*.http
--include=*.md --include=*.json`, which is the natural instinct and is **wrong**. It found the
seven e2e specs and the docs, and it missed two consumers, because the filter encoded an
assumption: *that a caller is something that compiles.*

| Missed | Why the sweep missed it |
| --- | --- |
| `http/posting/auth/staff-login-deprecated.posting.yaml` | An **extension** miss — `.yaml` was not in the filter. A Posting collection entry that *is* the alias: nothing chains off it, so here `rm` **is** the right operation, which is exactly what the controller was not. It is not compiled, not linted and in no test, so nothing downstream would ever have reported it. |
| `apps/api-gateway/.../dto/refresh.request.dto.ts` | A **pattern** miss, not an extension one — `--include=*.ts` covered the file; `.post('/api/auth/login')` never matches a Swagger string. `@ApiProperty({ description: 'Refresh JWT issued by /auth/login' })` is a dangling route in the **published OpenAPI schema** — the one artefact here that external clients actually read. It was wrong before this ADR too: a refresh token is issued by **two** logins, staff and customer, and it named one. |

The general form: **a build passing proves nothing about consumers that are not built.** HTTP
collections, CI YAML, seed scripts, shell drivers and API descriptions all name routes, and a
route removal must be checked against the whole tree — unfiltered, and by URL rather than by
call syntax — before it is checked against the compiler. On a route, the compiler is the *last*
line of defence, not the first: it has no opinion whatever about a URL inside a string.

## Consequences

### Positive

- One staff-login URL instead of two, and the one that survives is the one the documentation,
  the `.http` scenarios and 45 e2e suites already called canonical.
- The `@Public()` surface shrinks by one route. Every unauthenticated entry point is a thing
  that must be reasoned about; this one bought nothing.
- The deprecation is *executed* rather than *pending*, which is the only state a deprecation
  with no owner can safely be in.

### Negative

- **This is a breaking API change**, and it is worth stating without hedging: any consumer
  outside this repository calling `POST /api/auth/login` gets a `404` at deploy. Nothing in the
  repo can prove such a consumer does not exist. The judgement is that a route which was
  documented as deprecated from its first commit, and which no README, `.http` file or client
  ever presented as the path to use, is not one an external client can reasonably have adopted.

### Open

- Nothing prevents the next multi-prefix `@Controller([...])`. Like ADR-049's uncalled port
  methods, this is not expressible as a `boundaries` rule — the linter reasons about imports,
  not about route tables. What exists now is the 404 test and a landmine entry.

## Alternatives considered

- **Delete `staff-login.controller.ts`, as the instruction literally said.** Rejected: it
  removes staff authentication. See §Context — this is the whole reason the ADR exists.
- **Keep the alias; it costs nothing.** It costs what every unexecuted deprecation costs: a
  second public entry point that must be kept working, documented and tested forever, in
  exchange for a compatibility guarantee that protects nobody. The seven internal callers are
  evidence *for* removal, not against it — a "deprecated" path with in-repo traffic is a path
  the codebase has quietly re-adopted.
- **Mark it `@ApiExcludeEndpoint()` and leave it wired.** Hides the route from Swagger while
  keeping it live: the documentation and the system would then disagree, which is strictly worse
  than either honest state.
- **Redirect `/auth/login` → `/auth/staff/login` with a `308`.** A real option if an external
  client existed. It does not, and a permanent redirect is a permanent maintenance surface;
  a `404` is the honest answer to a route that was never anyone's contract.

---

## References

- [ADR-010](010-jwt-auth-and-refresh-rotation.md) — the login use case and refresh rotation the
  surviving route fronts.
- [ADR-046](046-libs-layout-and-dead-export-removal.md) — *a deletion queued behind a condition,
  with no owner and no check, is forgotten.* `CacheHelper` waited on a cache-key bump; this
  waited on "one release".
- [ADR-049](049-the-port-methods-nothing-calls.md) — the inverted-test move, and the recurring
  symptom: **the comment that vouches for a fact the code contradicts**. Three ADRs found a
  comment inventing a *caller*; this one found a comment inventing a *history*.
- [`docs/implementation/01-baseline-identity-staffuser-customer-rbac/04-customer-register-and-login.md`](../implementation/01-baseline-identity-staffuser-customer-rbac/04-customer-register-and-login.md)
  — where the alias was introduced, and simultaneously declared legacy; amended.
