# 07 — Kulala `auth.http` and `iam.http`

## What Kulala is

[Kulala](https://github.com/mistweaverco/kulala.nvim) is a Neovim plugin that
executes `.http` request files inline in the editor — same syntax as JetBrains
HTTP Client / VS Code REST Client, same `# @name` chaining and
`{{name.response.body.$.path}}` substitution. The `.http` files in this repo
are checked-in, version-controlled equivalents of a Postman collection,
browsable inside the editor and reviewable in pull requests.

## File overview

`http/auth.http` covers the auth controllers (staff + customer + admin-ping):

- `POST /api/auth/staff/login` (canonical) and `POST /api/auth/login` (the
  deprecated alias for one release).
- `POST /api/auth/refresh`, `POST /api/auth/logout`, `GET /api/auth/me`,
  `GET /api/auth/admin/ping`.
- `POST /api/auth/customer/register`, `POST /api/auth/customer/login`,
  `GET /api/auth/customer/me`.

`http/iam.http` covers the IAM admin controller
(`apps/api-gateway/src/modules/iam/presentation/iam.controller.ts`):

- `GET /api/iam/roles`, `POST /api/iam/roles`, `PATCH /api/iam/roles/:id`,
  `POST /api/iam/staff/:id/roles`, `DELETE /api/iam/staff/:id/roles/:roleName`.

The two files are independent — neither imports the other; the duplication
of the `adminLogin`/`staffLogin` block across them is intentional so each
file stands on its own when an operator opens it cold.

## Conventions

Both files mirror the shape of `http/order.http`:

- A top-of-file purpose comment naming every controller the file touches.
- `@baseUrl = {{ENV_BASE_URL}}` — `ENV_BASE_URL` is defined per environment
  in `http/http-client.env.json` (dev: `http://localhost:3000/api`). Kulala
  picks the active environment from a buffer-local selector.
- One block per request, separated by `###`.
- Each block leads with `# @name <handlerName>` so later blocks can
  reference the captured response via
  `{{handlerName.response.body.$.field}}`. The `$.` prefix is the JSONPath
  root.
- A `#`-prefixed comment names the route and explains the contract: body
  shape, status codes, and the relevant ADR or task where applicable.

A subtle detail in `iam.http`: the staff-login response (`TokenResponseDto`)
deliberately omits user info, so an `adminMe` block (`GET /api/auth/me`) sits
between `adminLogin` and the assign/revoke blocks to supply the staff-user
id via `{{adminMe.response.body.$.id}}`. Routing "who am I" through `/me`
keeps the login response narrow and is consistent with how the staff-side
SPA will resolve the current user.

## Operator workflow

For "manually test a new IAM change" against a freshly-seeded gateway:

```bash
docker compose up -d mysql redis rabbitmq
yarn migration:run
yarn test:seed     # creates admin@example.com / admin1234
yarn start:dev:api-gateway
```

Then in Neovim:

1. Open `http/iam.http`.
2. Place the cursor on `# @name adminLogin` and run Kulala's "send request"
   keybind. The block returns 200 with `accessToken`/`refreshToken`.
3. Send `# @name adminMe`. The response carries the admin's staff-user id.
4. Send any later block — the bearer header and the `:id` path segment
   substitute automatically from the two captures above.

For the auth file the entry point is `# @name staffLogin`; every later block
references `{{staffLogin.response.body.$.accessToken}}` or
`{{staffLogin.response.body.$.refreshToken}}`.

## What's missing

Two follow-up cleanups are out of scope here but worth flagging:

- `http/order.http` and `http/product.http` have no chained auth block.
  Operators currently send the request unauthenticated (the global guard
  rejects it) or hand-paste a token into the `Authorization` header. A
  follow-up task could either add a leading login block to each file
  (matching the iam.http pattern) or factor a shared login fragment when
  Kulala supports request includes.
- `http/http-client.env.json` could grow `adminEmail` / `adminPassword`
  entries to avoid hardcoding `admin@example.com` / `admin1234` in two
  places, but the convention in the existing files is to hardcode literal
  values in the `.http` body rather than expand the env JSON, so this stays
  as-is.
