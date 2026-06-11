import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMediaAssetTable1781190892429 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // `media_asset` is a POLYMORPHIC table: one row references either a `product`
    // or a single `product_variant` via `(owner_type, owner_id)`. There is
    // DELIBERATELY NO FOREIGN KEY on `owner_id` — a foreign key can only target one
    // table, and this column points at two depending on `owner_type`. The
    // compensations for the missing FK are (1) the use-case existence check, which
    // probes `product` / `product_variant` by id before an attach, and (2) the
    // composite `IDX_MEDIA_ASSET_OWNER (owner_type, owner_id, sort_order)` index
    // below, under which every owner-scoped read (list / max-slot / reorder) is a
    // covered range scan rather than a full-table scan (ADR-029 §4).
    //
    // `id` is BIGINT UNSIGNED AUTO_INCREMENT to match the catalog convention (see
    // CreateCatalogTables / CreateCategoryTables); `owner_id` is BIGINT UNSIGNED to
    // line up with the `product`/`product_variant` PKs it logically references.
    // `uri` is VARCHAR(1024) — an opaque, already-uploaded reference, never parsed.
    // `deleted_at` is inherited from `BaseEntity` but stays NULL forever: media
    // soft-delete is the `status` flip to `archived` (detach), not a timestamp
    // (ADR-025).
    await queryRunner.query(`
      CREATE TABLE media_asset (
        id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        owner_type ENUM('product','product-variant') NOT NULL,
        owner_id   BIGINT UNSIGNED NOT NULL,
        uri        VARCHAR(1024) NOT NULL,
        type       ENUM('image','video','document') NOT NULL,
        alt_text   VARCHAR(255) NULL,
        sort_order INT NOT NULL DEFAULT 0,
        status     ENUM('active','archived') NOT NULL DEFAULT 'active',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP NULL
      );
    `);

    await queryRunner.query(
      'CREATE INDEX IDX_MEDIA_ASSET_OWNER ON media_asset (owner_type, owner_id, sort_order);',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE media_asset;');
  }
}
