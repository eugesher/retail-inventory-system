# Persistence

This file covers the MySQL schema as the migrations leave it today, and the tooling around it: the
two migration pipelines, the database init script and the test seed. The claims about the schema were
checked against a database built by `yarn test:infra:reload` on MySQL 8.4.8. When a later migration
changed a table, that migration is the source; the one that created the table may no longer describe
it. The choice of TypeORM and MySQL is
[ADR-019](../adr/019-typeorm-and-mysql-for-persistence.md), the two logical databases are
[ADR-034](../adr/034-isolated-eventstore-database.md), the generated-column technique is
[ADR-026](../adr/026-price-append-only-ledger-and-tax-category.md), and erasure is
[ADR-037](../adr/037-consent-record-and-tombstone-erasure.md). The dedupe rules of each module are in
[`inventory.md`](inventory.md#stockmovement), [`notifications.md`](notifications.md) and
[`event-store.md`](event-store.md#ingest-into-domain_event).

## Two databases, two migration pipelines

- **`ris_eventstore` is created by an init script, not by a migration.**
  `scripts/mysql-init/01-create-eventstore-db.sql` creates it (`utf8mb4`, `utf8mb4_0900_ai_ci`) and
  grants `ALL` on it to `retail`@`%`. `docker-compose.yml` mounts `scripts/mysql-init/` at
  `/docker-entrypoint-initdb.d/`. The MySQL image runs those files only when its data directory is
  empty, after it has created `MYSQL_DATABASE` (`retail_db`) and `MYSQL_USER` (`retail`), so the
  `GRANT` finds the user (`/usr/local/bin/docker-entrypoint.sh` in `mysql:8.4.8`: `docker_setup_db`,
  then `docker_process_init_files`). An existing volume never runs it again. `yarn test:infra:down`
  is `docker compose down -v`, so the next `test:infra:up` starts from an empty volume and runs it. A
  GitHub service container cannot take the mount, so the CI `e2e` job pipes the same file to `mysql`
  as root ([`build-and-ci.md`](build-and-ci.md#ci-githubworkflowsci-cdyml)).
- **Each database has its own data source, its own migrations folder and its own `migrations`
  table.** `migrations/config/data-source.ts` reads `DATABASE_URL` and loads
  `migrations/*{.ts,.js}`. `migrations/config/eventstore-data-source.ts` reads
  `EVENTSTORE_DATABASE_URL` and loads `migrations/eventstore/*{.ts,.js}`. Neither glob descends into
  a subfolder, so neither pipeline sees the other's files or `migrations/config/`. `yarn
migration:run` alone therefore leaves `ris_eventstore` without tables. `yarn test:infra:reload`
  runs both.
- **TypeORM identifies an applied migration by its class name** (the `name` column of the
  `migrations` table). An edit to the text of a migration that has already run changes nothing on
  that database. The edit takes effect only on a database built from scratch.
- **The migration CLI and the seed read one env file; the services read two.** The two data sources
  and `scripts/test-db-seed.ts` load the first of `.env.local` and `.env` that exists and ignore the
  other. `dotenv` does not overwrite a variable that is already set. The data sources check only
  their own URL with Joi. The services load both files through `ConfigModule`, with `.env.local`
  winning (`libs/config/config-module.config.ts`, `envFilePath`). A key that only `.env` holds reaches
  the services, but not the migration CLI or the seed while `.env.local` exists.
- **`yarn migration:create <Name>`** scaffolds into `migrations/`.
  `yarn migration:create:eventstore <Name>` passes `--dir eventstore` and scaffolds into
  `migrations/eventstore/` (`scripts/migration-create.ts`). With no name, the script logs an error
  and exits with status 1.

## The migrations are the schema

- **`synchronize` is off** (`libs/database/database.module.ts`, `DatabaseModule.forRoot`), so the DDL
  in `migrations/` is the only definition of a table. The entities describe less than the tables do:
  - `BaseEntity`'s `@PrimaryGeneratedColumn()` is `int` in TypeORM metadata
    (`libs/database/base.entity.ts`), while the tables use `BIGINT UNSIGNED`. The exception is
    `tax_category.id`, which is `INT UNSIGNED`, and so is `product_variant.tax_category_id`, which
    references it.
  - The three generated columns (`price.open_scope_key`, `notification_delivery.delivery_dedupe_key`,
    `stock_movement.movement_dedupe_key`) are mapped on no entity. MySQL rejects an `INSERT` that
    names one (error 3105).
- **A `BIGINT` read through TypeORM comes back as a string.** TypeORM's MySQL driver enables
  `supportBigNumbers` and `bigNumberStrings` ([`testing.md`](testing.md)), so the mappers wrap ids and
  money columns in `Number(...)` (for example `PaymentMapper` in
  `apps/retail-microservice/src/modules/orders/infrastructure/persistence/payment.mapper.ts`). The
  seed uses `mysql2` directly and gets numbers.

### `deleted_at`

Only one table ever has `deleted_at` set.

| Tables                                                                                                                                   | How the entity maps `deleted_at`                      | What that means                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| the 19 entities that extend `BaseEntity` (catalog, pricing, `stock_level`, `stock_movement`, `cart_line`, orders, returns, notification) | `@DeleteDateColumn`                                   | TypeORM adds `deleted_at IS NULL` to every `find`. Nothing sets the column: `BaseTypeormRepository.softDelete` has no caller |
| `staff_user`                                                                                                                             | `@DeleteDateColumn` on its own entity                 | the same, and nothing sets it                                                                                                |
| `customer`                                                                                                                               | a plain `@Column`                                     | `Customer.erase` stamps it. A tombstoned customer is still returned by every read                                            |
| `cart`, `address`, `reservation`, `stock_location`                                                                                       | not mapped; these entities do not extend `BaseEntity` | the column exists in the table and nothing reads or writes it                                                                |

Some tables have no `deleted_at` at all: `consent_record` has only `updated_at`, `idempotency_key` has
`created_at` and `expires_at`, and `permission`, `role` and the two auth join tables have none. In
`ris_eventstore`, `domain_event` and `audit_log_entry` have `occurred_at` and `received_at`, both
`TIMESTAMP(3)`, and nothing else. `stock_movement.updated_at` never changes after the insert, because
the ledger is append-only.

## Collations

- **`retail_db` has two collation families.** The auth tables (`staff_user`, `customer`, `role`,
  `permission`, `role_permissions`, `staff_user_roles`, `consent_record`) and every retail table
  (`cart`, `cart_line`, `order`, `order_line`, `address`, `payment`, `fulfillment`,
  `fulfillment_line`, `refund`, `idempotency_key`, `return_request`, `return_line`) are
  `utf8mb4_unicode_ci`. The catalog, pricing, inventory and notification tables take the server
  default, `utf8mb4_0900_ai_ci`. `ris_eventstore` is created with `utf8mb4_0900_ai_ci`.
- **A string foreign key needs the same charset and collation on both columns.** `reservation`
  belongs to the inventory family, but it references `cart.id`. So its table is at the server
  default and only its `cart_id` column is `utf8mb4_unicode_ci`
  (`migrations/1781309334478-CreateReservationTable.ts`).
- `fulfillment.stock_location_id` is a `utf8mb4_unicode_ci` `VARCHAR(64)`, while
  `stock_location.id` is `utf8mb4_0900_ai_ci`. There is no foreign key between them: retail does not
  reference inventory's tables.

## Uniqueness that MySQL cannot state directly

- **A UNIQUE index lets any number of `NULL`s through.** The schema relies on that in three places:
  - `product_variant.gtin` is nullable and UNIQUE;
  - `return_request.rma_number` stays `NULL` until the second statement of the open writes it
    ([`retail-returns.md`](retail-returns.md));
  - `customer.email` is UNIQUE, and every erased customer's email is `NULL`, so tombstones never
    collide.
- **A stored generated column under a UNIQUE index gives a partial unique.** Each such column holds
  a key only for the rows the rule covers, and `NULL` for every other row:

  | Column (`UNIQUE`)                                                               | Non-`NULL` when                                    | Key                                                                                 |
  | ------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------- |
  | `price.open_scope_key` (`UC_PRICE_OPEN_SCOPE`)                                  | `valid_to IS NULL`                                 | `variant_id:currency` — one open price per variant and currency                     |
  | `notification_delivery.delivery_dedupe_key` (`UC_NOTIFICATION_DELIVERY_DEDUPE`) | `recipient_customer_id IS NOT NULL`                | `template_id:event_reference_type:event_reference_id:channel:recipient_customer_id` |
  | `stock_movement.movement_dedupe_key` (`UC_STOCK_MOVEMENT_DEDUPE`)               | `type` is `sale` or `return`                       | `type:reference_type:reference_id:variant_id:stock_location_id`                     |
  |                                                                                 | `type = 'release'` and `operation_key IS NOT NULL` | `release:operation_key:variant_id:stock_location_id`                                |

- **The ledger key carries the variant and the location.** One Commit Sale writes a `sale` row for
  every line, and all of them share one `fulfillmentId`. A key without `variant_id` and
  `stock_location_id` would reject the second line of every multi-line shipment. A transfer writes
  two `adjustment` rows under one `transfer` reference, and `adjustment` is outside the key.
  `test/concurrent-commit-sale.e2e-spec.ts` pins the race, the two-line shipment and the transfer.
  Why the `release` arm needs a caller-minted key is
  [ADR-057](../adr/057-cancel-allocation-needs-an-operation-identity.md).
- **`CONCAT` with a `NULL` argument is `NULL`.** A `sale` or `return` row written without a reference
  therefore falls outside the constraint rather than colliding with other reference-less rows.
- **The widths leave room.** `movement_dedupe_key` is `VARCHAR(200)`. Its longest `sale`/`return` key
  is 190 characters and its longest `release` key is 158. That counts the reference columns at their
  declared widths and a `BIGINT UNSIGNED` as 20 digits. `open_scope_key` is `VARCHAR(32)` against a
  longest key of 24.
- **Changing a generated column** (checked on MySQL 8.4.8):
  - `ALTER TABLE … MODIFY` can change the expression of a stored generated column while a UNIQUE index
    covers it. MySQL rebuilds the table and checks the index again.
  - Dropping an indexed generated column drops its single-column index with it.
  - MySQL refuses to drop a base column that a generated column reads (error 3108). This is why
    `AddStockMovementOperationKey1784010000000.down` restores the two-arm expression before it drops
    `operation_key`.
- The other natural keys are covered where their behaviour is: the all-statuses `reservation` triple
  in [`inventory.md`](inventory.md#reservation), the `idempotency_key` primary key
  `(scope, key)` in [ADR-036](../adr/036-idempotency-key-store-and-enforced-occ.md), and the
  `domain_event` dedupe key in [`event-store.md`](event-store.md#ingest-into-domain_event).

## CHECK constraints

MySQL 8.4 enforces `CHECK`, and a violating write fails with error 3819. The schema has six:

- `CK_STOCK_LEVEL_ON_HAND`, `CK_STOCK_LEVEL_ALLOCATED` and `CK_STOCK_LEVEL_RESERVED`: each counter is
  at least 0;
- `CK_CART_LINE_QTY` and `CK_RESERVATION_QTY`: the quantity is greater than 0;
- `CHK_ORDER_LINE_CANCELLED_QUANTITY`: `0 ≤ cancelled_quantity ≤ quantity`.

Each one repeats an invariant the domain model already enforces. No code translates error 3819 into
a domain error code, so if a write does reach one, it fails as an unmapped driver error.

## Foreign keys and deletes

- **The application hard-deletes only rows that no foreign key points at.** These are:
  - expired `idempotency_key` rows, and a pending one that Issue Refund releases (`IssueRefundUseCase.releaseReservation`);
  - `notification_delivery` rows past the retention horizon;
  - `cart_line` rows removed from a cart;
  - a `product_categories` membership;
  - an erased customer's `consent_record`;
  - the rows of the two auth join tables, when roles or permissions are reassigned.

  So the `ON DELETE` rules below take effect only on a delete made by hand.

- **`SET NULL`:** `order.customer_id`, `cart.customer_id`, `order.source_cart_id`,
  `category.parent_id`, `product_variant.tax_category_id`.
- **`CASCADE`:** `consent_record.customer_id`, `cart_line.cart_id`, `fulfillment_line.fulfillment_id`,
  `return_line.return_request_id`, both columns of `product_categories`, `role_permissions` and
  `staff_user_roles`.
- **Every other foreign key restricts the delete.** One asymmetry is worth knowing:
  `return_request.customer_id` is `NOT NULL` and restricts, while `order.customer_id` is nullable and
  sets `NULL`. Erasure tombstones the customer row in place, so neither rule fires.
- **Some columns reference another row with no foreign key:**
  - `media_asset.owner_id` and `address.owner_id` are polymorphic over their `owner_type`;
  - `stock_movement.reference_id` is polymorphic over `reference_type`, and
    `IDX_STOCK_MOVEMENT_REFERENCE` serves the lookup;
  - `fulfillment.stock_location_id` points from retail into inventory;
  - `notification_delivery.recipient_customer_id` and `event_reference_id` carry no foreign key;
  - `ris_eventstore` has no foreign keys at all.
- **`address.owner_type` admits `customer`, but only `order` rows are ever written.** The domain
  builds addresses only for an order (`Address`, in
  `apps/retail-microservice/src/modules/orders/domain/address.model.ts`), and no code outside specs
  names `AddressOwnerTypeEnum.CUSTOMER`.

## Reserved words

`order`, `key` (`idempotency_key`), `condition` (`return_line`) and `before` (`audit_log_entry`) are
reserved words in MySQL. The migrations backtick them, and so must any raw SQL that names them.

## Changing an `ENUM`

- **Adding a member is a `MODIFY COLUMN` with the whole list** (and the default, where there is one).
  `AddCapturingPaymentStatus1783950354385` and `AddSkippedNoConsentDeliveryStatus1783269124759` are
  the two examples.
- **Removing a member fails while a row still holds it.** The default `sql_mode` includes
  `STRICT_TRANS_TABLES`, so the `ALTER` stops with error 1265 instead of rewriting the row (checked on
  MySQL 8.4.8). `AddCapturingPaymentStatus.down` counts the `capturing` payments first and throws a
  message that names the count. `AddSkippedNoConsentDeliveryStatus.down` has no such check and
  relies on the `ALTER` failing.

## Reverting

- **MySQL commits every DDL statement on its own.** A `down` that fails part-way leaves the
  statements before the failure applied.
- **Some `down`s succeed only on data the later code has not written yet:**
  - `AddConsentAndTombstoneColumns.down` makes `customer.email` and the five `address` PII columns
    `NOT NULL` again, which fails once any customer has been erased;
  - `AddCapturingPaymentStatus.down` refuses while any payment is `capturing`;
  - the `down` of any `CREATE TABLE` migration drops the table with its rows.

## The test seed (`yarn test:seed`)

- **Identity first, then SQL.** `scripts/test-db-seed.ts` writes permissions, roles, the four staff
  users and the customer in code. Then it runs the files of `TestDbSeedUtil.seedFiles`
  (`scripts/utils/test-db-seed.util.ts`) in list order. `cart.sql` and `consent-record.sql` reference
  the seeded customer, so they depend on the identity pass.
- **The SQL-file parser is naive** (`TestDbSeedUtil.parseSqlStatements`). It deletes everything from
  `--` to the end of the line, inside a quoted string as well, and splits on every `;`. A string
  literal in a seed file must therefore contain neither `--` nor `;`. That rules out a Handlebars
  `{{!-- … --}}` comment in a template body.
- **Re-running is safe, but it is not a reset.** The seeded users are upserted
  (`ON DUPLICATE KEY UPDATE`): a re-run restores their password hash and status and clears
  their refresh-token hash. Every other row is `INSERT IGNORE`d, or added by
  `INSERT … SELECT … WHERE NOT EXISTS` in the case of `cart_line`, whose id is auto-increment. So a row
  that a test changed keeps its changes, and a changed permission or role description is not
  updated.
- **Every `PermissionCodeEnum` member needs a `PERMISSION_SEEDS` entry.** The `admin` role takes
  `Object.values(PermissionCodeEnum)`, and `seedRoles` looks up each code's row id in
  `PERMISSION_SEEDS`. A missing member throws `seedRoles: missing permission id for code <code>`,
  and the seed exits with status 1. The permission rows and part of the `admin` role are written by
  then.
- **Seed ids share one pattern and differ in one group:** `00000000-0000-4000-<group>-…`, with `a000`
  for users, `b000` permissions, `c000` roles and `d000` carts.

## Failure modes

| What breaks                                                        | How it shows                                                                                 | What recovers it                                                                |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `yarn migration:run` run without `migration:run:eventstore`        | `domain_event` and `audit_log_entry` do not exist, so every event-store write and read fails | Run both pipelines, or `yarn test:infra:reload`                                 |
| An existing MySQL volume predates `01-create-eventstore-db.sql`    | `ris_eventstore` does not exist; the event-store migrations fail with `Unknown database`     | `yarn test:infra:down` (it drops the volume), or run the script by hand as root |
| A new `PermissionCodeEnum` member without a `PERMISSION_SEEDS` row | `yarn test:seed` exits 1 naming the code                                                     | Add the row with the next `b000` id                                             |
| A seed string contains `;` or `--`                                 | The statement is cut, and MySQL reports a syntax error                                       | Rephrase the literal, or teach `parseSqlStatements` to respect quotes           |
| A migration edited after it has run                                | Existing databases keep the old shape; only a fresh one gets the new DDL                     | Write a new migration                                                           |
| A `down` fails part-way                                            | The schema is between two versions and the `migrations` table still lists the migration      | Finish or undo the remaining statements by hand                                 |
