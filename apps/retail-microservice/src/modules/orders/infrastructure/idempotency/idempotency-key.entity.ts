import { Column, Entity, PrimaryColumn } from 'typeorm';

// One stored-response row of the retail idempotency store, in the shared `retail_db`
// (docs/adr/036-idempotency-key-store-and-enforced-occ.md).
//
// It deliberately does NOT extend `@retail-inventory-system/database`'s `BaseEntity`.
// A stored-response record is immutable: there is no auto-increment surrogate id, no
// `version`, and no `updated_at` / `deleted_at` — those columns MUST simply be absent
// (the append-only `domain_event` precedent, stronger than `stock_movement`'s
// "inert by construction" — ADR-034 / ADR-030). Only `created_at` (DB-defaulted to the
// row's birth) and `expires_at` (the TTL horizon, set explicitly by the repository
// from `created_at + IDEMPOTENCY_KEY_TTL_HOURS`) exist.
//
// The PRIMARY KEY is the composite `(scope, key)` — two `@PrimaryColumn`s, the
// caller-assigned-PK precedent (`Reservation` / `Cart` declare their own PK rather than
// inheriting `BaseEntity`'s numeric id). `scope` namespaces the client key by operation
// so the same `Idempotency-Key` cannot collide across two unrelated writes. `key` maps
// to the `key` column (a MySQL reserved word — TypeORM backticks it in generated SQL;
// the migration backticks it in DDL).
//
// The composite PK and the `expires_at` index live in the migration (the source of
// truth with `synchronize` off — the `domain_event` / `stock_movement` convention).
// SnakeNamingStrategy maps `requestFingerprint` → `request_fingerprint`,
// `responseStatus` → `response_status`, etc. (ADR-019).
@Entity('idempotency_key')
export class IdempotencyKeyEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  public scope: string;

  @PrimaryColumn({ type: 'varchar', length: 64 })
  public key: string;

  @Column({ type: 'char', length: 64 })
  public requestFingerprint: string;

  @Column({ type: 'int' })
  public responseStatus: number;

  @Column({ type: 'json' })
  public responseBody: Record<string, unknown>;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @Column({ type: 'timestamp' })
  public expiresAt: Date;
}
