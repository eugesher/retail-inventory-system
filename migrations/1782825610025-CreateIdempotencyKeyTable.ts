import { MigrationInterface, QueryRunner } from 'typeorm';

// Creates the `idempotency_key` table — the retail microservice's stored-response
// dedup substrate for the money- and stock-moving HTTP writes (place order, capture
// payment, ship fulfillment, issue refund). It is the backing store for the
// `Idempotency-Key` header that the write surface previously accepted-but-logged
// without acting on (docs/adr/036-idempotency-key-store-and-enforced-occ.md,
// docs/adr/028-cart-order-payment-and-address-chain.md).
//
// There is exactly ONE idempotency store, retail-owned, in the shared `retail_db`.
// Inventory writes already have natural-key idempotency (Reserve on its
// `(cart_id, variant_id, stock_location_id)` UNIQUE, Commit-sale / Restock on the
// movement ledger), so an inventory-side table would be dead code (ADR-036 §1).
//
// Shape:
//   - Composite PRIMARY KEY `(scope, key)`. `scope` namespaces the client key by
//     operation (e.g. `place-order`, `capture-payment`) so the same client key cannot
//     collide across two unrelated writes; `key` is the client-supplied
//     `Idempotency-Key`. The composite PK is also the concurrent-double-submit dedup
//     anchor — the second racing INSERT loses on the PK (ER_DUP_ENTRY) and is served
//     as a replay (the `reservation` natural-key precedent, ADR-030).
//   - It does NOT model `BaseEntity`: a stored-response row is immutable, so there is
//     no surrogate auto-increment id, no `version`, and no `updated_at` / `deleted_at`.
//     Only `created_at` (row birth) and `expires_at` (TTL horizon) exist — the
//     append-only `stock_movement` / `domain_event` precedent (ADR-030 / ADR-034).
//   - `expires_at` is computed by the repository on insert from
//     `created_at + IDEMPOTENCY_KEY_TTL_HOURS`; the scheduled purge sweep deletes rows
//     past it, so it is indexed for that range scan.
//   - `request_fingerprint` is the SHA-256 hex (CHAR(64)) of the canonicalized request
//     body; a replay must match it or the write is a key-reuse error (`422`).
//   - `response_body` / `response_status` are the cached response returned verbatim on
//     replay. They are **NULLABLE**: the reserve-first refund flow (ADR-036 concurrency
//     hardening) INSERTs a `pending` row — the `(scope, key)` claimed before the gateway
//     call, its response NULL until a follow-up `finalize` fills it in — so a truly
//     concurrent duplicate loses the PK and is turned away before it can refund twice. A
//     NULL `response_body` marks a pending (in-flight) reservation; a non-NULL one a
//     completed, replayable record. The `find`/`save` flow (place/capture/ship) only ever
//     writes completed rows.
//
// `key` is backticked — it is a MySQL reserved word. `utf8mb4_unicode_ci` so the
// implicit collation matches the rest of the schema. `synchronize` stays off, so this
// migration is the source of truth for the table shape (ADR-019).
export class CreateIdempotencyKeyTable1782825610025 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE idempotency_key (
        scope               VARCHAR(64) NOT NULL,
        \`key\`               VARCHAR(64) NOT NULL,
        request_fingerprint CHAR(64)    NOT NULL,
        response_status     INT         NULL,
        response_body       JSON        NULL,
        created_at          TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at          TIMESTAMP   NOT NULL,
        PRIMARY KEY (scope, \`key\`)
      ) COLLATE = utf8mb4_unicode_ci;
    `);
    await queryRunner.query(
      'CREATE INDEX IDX_IDEMPOTENCY_KEY_EXPIRES_AT ON idempotency_key (expires_at);',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS idempotency_key;');
  }
}
