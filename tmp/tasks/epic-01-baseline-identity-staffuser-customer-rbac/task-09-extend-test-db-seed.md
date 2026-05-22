---
epic: epic-01
task_number: 9
title: Extend `scripts/test-db-seed.ts` with the full seed set (4 staff + 1 customer + role bindings)
depends_on: [task-01, task-02, task-05]
doc_deliverable: none
---

# Task 09 — Extend `scripts/test-db-seed.ts` with the full epic-01 seed set

## Goal

The seed script today only writes the admin StaffUser (task-02 reduced it from the original two-user set when the `customer@example.com` row moved to the `customer` table). The epic-01 acceptance set requires four StaffUsers (one per canonical role) and one Customer. This task fills out the seed.

The seed must be idempotent (safe to re-run) and must produce a fixture set that satisfies every e2e test the epic introduces — especially the non-admin-403 assertion in `test/auth.e2e-spec.ts` (task-04) and the IAM round-trip in `test/iam.e2e-spec.ts` (task-06).

No new code beyond the seed script; no doc deliverable (the seed set is reference-documented in `README.md`'s "Local development" section, which task-10 updates).

## Entry state assumed

Tasks 1–8 complete:

- `permission` table has 12 rows; `role` table has 4 rows; `role_permissions` has 24 bindings.
- `staff_user` table exists with admin row; `staff_user_roles` has one binding (admin → admin).
- `customer` table exists; no rows.
- All endpoints behave correctly under fresh schema.

## Scope

**In:**

- Extend `TEST_USERS` to four staff entries + one customer entry.
- Add `seedCustomers(connection)` that writes the customer entry (separate function from `seedUsers` to keep the per-table seed logic clean).
- Update `seedUsers` to seed all four staff entries and bind each to its canonical role via `staff_user_roles`.
- Keep deterministic UUIDs so e2e tests can reference fixtures by id without first looking them up.

**Out:**

- Doc changes (covered by task-10's README pass).
- Any change to migration files or production code.

## Seed set (the epic's floor)

| Email | Password | Role binding |
| --- | --- | --- |
| `admin@example.com` | `admin1234` | `admin` |
| `catalog@example.com` | `catalog1234` | `catalog-manager` |
| `warehouse@example.com` | `warehouse1234` | `warehouse-staff` |
| `support@example.com` | `support1234` | `order-support` |
| `customer@example.com` | `customer1234` | (Customer row — no role binding) |

The first four go into `staff_user`; the last goes into `customer`. Match the existing UUID-namespace convention (`00000000-0000-4000-a000-00000000000X`) — keeps IDs stable across reruns and dump-and-restore cycles.

Suggested IDs:

| Email | UUID |
| --- | --- |
| `admin@example.com` | `00000000-0000-4000-a000-000000000001` |
| `catalog@example.com` | `00000000-0000-4000-a000-000000000003` |
| `warehouse@example.com` | `00000000-0000-4000-a000-000000000004` |
| `support@example.com` | `00000000-0000-4000-a000-000000000005` |
| `customer@example.com` | `00000000-0000-4000-a000-000000000002` (matches the original assignment so any pre-existing fixture references continue to work) |

Permission codes (12 total) and role UUIDs are owned by task-01's seed extension; **do not redefine them here** — look up the role id by name when inserting `staff_user_roles` rows.

## Files to modify

- `scripts/test-db-seed.ts`:
  - Extend `TEST_USERS` to four staff entries.
  - Add a parallel `TEST_CUSTOMERS` constant for the single customer entry (`{ id, email, password, firstName, lastName, status: 'active' }`).
  - Update `seedUsers`:
    - INSERT one row per staff entry. Column shape per task-02's `staff_user` table (`id`, `email`, `password_hash`, `status='active'`, `last_login_at=NULL`, `refresh_token_hash=NULL`).
    - After each INSERT, look up the role id by name (one SELECT per role) and INSERT IGNORE into `staff_user_roles` to bind. Use `ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), refresh_token_hash = NULL` on `staff_user` for idempotency.
  - Add `seedCustomers`:
    - For each entry in `TEST_CUSTOMERS`: hash password with the same argon2 options as `seedUsers`; INSERT into `customer` with `password_hash`, `first_name`, `last_name`, `status='active'`, `email_verified_at=NULL`, `phone=NULL`, `refresh_token_hash=NULL`. `ON DUPLICATE KEY UPDATE` mirroring the staff seed.
  - Call sequence inside `seed()`:
    1. `seedPermissions(connection)` (task-01).
    2. `seedRoles(connection)` (task-01).
    3. `seedUsers(connection)` (extended here).
    4. `seedCustomers(connection)` (new).
- `test/auth.e2e-spec.ts` — if task-04's non-admin-403 assertion fixtured a one-off StaffUser inline (per task-04's hedge), replace it with the now-seeded `warehouse@example.com` user.

## Files to add

None.

## Files to delete

None.

## Tests

No new unit/e2e tests; the seed is consumed by every other test. Verify:

- After `yarn migration:run && yarn seed`: `SELECT COUNT(*) FROM staff_user` returns 4; `SELECT COUNT(*) FROM customer` returns 1; `SELECT COUNT(*) FROM staff_user_roles` returns 4.
- Running `yarn seed` a second time produces no errors and no duplicate rows.
- Existing `yarn test:e2e` suite is still green; the IAM round-trip (`test/iam.e2e-spec.ts`) can find `warehouse@example.com` for its assign/revoke target without inline fixturing.

## Doc deliverable

None for this task. Task-10's README pass updates the "Local development → Seed users" table to mirror the new set.

## Carryover produced

- `staff_user` has 4 rows; `customer` has 1 row; `staff_user_roles` has 4 bindings.
- Every test that relies on a non-admin StaffUser can use `warehouse@example.com` / `catalog@example.com` / `support@example.com` without inline fixturing.

## Exit criteria

- [ ] `yarn seed` runs cleanly on a fresh schema; re-running is idempotent.
- [ ] `SELECT email, status FROM staff_user ORDER BY email` returns the four staff entries in `active` status.
- [ ] `SELECT email, status FROM customer` returns one row, `active`.
- [ ] `SELECT su.email, r.name FROM staff_user su JOIN staff_user_roles sur ON sur.staff_user_id = su.id JOIN role r ON r.id = sur.role_id ORDER BY su.email` returns one row per staff entry with the binding from the table above.
- [ ] All admin and warehouse fixtures in e2e tests reference the seeded UUIDs (`grep -rn "0000000000001\|0000000000004" test/` shows the references).
- [ ] `yarn test:e2e` is green end-to-end.
- [ ] No file outside `tmp/` references `tmp/`.
