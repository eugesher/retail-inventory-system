import { MigrationInterface, QueryRunner } from 'typeorm';

export class DropRedundantReservationExpiresAtIndex1783647515262 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IDX_RESERVATION_EXPIRES_AT ON reservation;');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE INDEX IDX_RESERVATION_EXPIRES_AT ON reservation (expires_at);');
  }
}
