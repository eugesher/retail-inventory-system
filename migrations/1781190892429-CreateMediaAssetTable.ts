import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMediaAssetTable1781190892429 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
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
