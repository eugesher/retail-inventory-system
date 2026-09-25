import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddStockMovementOperationKey1784010000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE stock_movement ADD COLUMN operation_key VARCHAR(64) NULL;',
    );
    await queryRunner.query('ALTER TABLE stock_movement DROP INDEX UC_STOCK_MOVEMENT_DEDUPE;');
    await queryRunner.query('ALTER TABLE stock_movement DROP COLUMN movement_dedupe_key;');
    await queryRunner.query(`
      ALTER TABLE stock_movement
        ADD COLUMN movement_dedupe_key VARCHAR(200)
          GENERATED ALWAYS AS (
            CASE WHEN type IN ('sale','return')
                 THEN CONCAT(type, ':', reference_type, ':', reference_id, ':',
                             variant_id, ':', stock_location_id)
                 WHEN type = 'release' AND operation_key IS NOT NULL
                 THEN CONCAT('release:', operation_key, ':',
                             variant_id, ':', stock_location_id)
                 ELSE NULL END
          ) STORED,
        ADD CONSTRAINT UC_STOCK_MOVEMENT_DEDUPE UNIQUE (movement_dedupe_key);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE stock_movement DROP INDEX UC_STOCK_MOVEMENT_DEDUPE;');
    await queryRunner.query('ALTER TABLE stock_movement DROP COLUMN movement_dedupe_key;');
    await queryRunner.query(`
      ALTER TABLE stock_movement
        ADD COLUMN movement_dedupe_key VARCHAR(200)
          GENERATED ALWAYS AS (
            CASE WHEN type IN ('sale','return')
                 THEN CONCAT(type, ':', reference_type, ':', reference_id, ':',
                             variant_id, ':', stock_location_id)
                 ELSE NULL END
          ) STORED,
        ADD CONSTRAINT UC_STOCK_MOVEMENT_DEDUPE UNIQUE (movement_dedupe_key);
    `);
    await queryRunner.query('ALTER TABLE stock_movement DROP COLUMN operation_key;');
  }
}
