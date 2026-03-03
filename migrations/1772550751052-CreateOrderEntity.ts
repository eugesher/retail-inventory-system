import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOrderEntity1772550751052 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS \`order\` (
        id              VARCHAR(36)  NOT NULL PRIMARY KEY,
        customerId      VARCHAR(36)  NOT NULL,
        items           JSON         NOT NULL,
        shippingAddress TEXT         NOT NULL,
        total           INT UNSIGNED NOT NULL,
        status          ENUM ('pending', 'confirmed', 'failed')
                                     NOT NULL,
        createdAt       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX IDX_OrderCustomer (customerId)
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS `order`;');
  }
}
