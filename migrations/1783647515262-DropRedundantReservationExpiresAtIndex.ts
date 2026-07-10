import { MigrationInterface, QueryRunner } from 'typeorm';

// Drops `IDX_RESERVATION_EXPIRES_AT (expires_at)`, which no query in the schema can
// select. `IDX_RESERVATION_STATUS_EXPIRES_AT (status, expires_at)` is a strict superset
// for every read `reservation` admits: the sweeper's candidate scan
// (`status = 'active' AND expires_at < :now ORDER BY expires_at ASC, id ASC`) matches its
// `status` equality prefix, which leaves `expires_at` ordered — so the range filter and
// the ORDER BY come from one covering read. The optimizer agrees: it costs the composite
// at 0.46 and the single-column index at 0.71 (`Using index condition`, `filtered: 14.93%`).
//
// A single-column `expires_at` index could only ever win for a predicate on `expires_at`
// with NO `status` filter, since a composite serves only its leftmost prefix. No such query
// exists, and a future retention purge would not be one: an `active` hold must never be
// purged, so a purge has to filter on status too. `expires_at` is rewritten by every
// Reserve, `refresh()` and Allocate, so the dead index was pure write amplification on the
// hottest column of a hot table.
//
// `synchronize` stays off (ADR-019) — the entity declares no `@Index` for this column, so
// nothing recreates it. The `down` restores the index exactly as
// `1781309334478-CreateReservationTable` created it, and is a pure metadata + build step:
// no row is read or written by either direction.
export class DropRedundantReservationExpiresAtIndex1783647515262 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IDX_RESERVATION_EXPIRES_AT ON reservation;');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE INDEX IDX_RESERVATION_EXPIRES_AT ON reservation (expires_at);');
  }
}
