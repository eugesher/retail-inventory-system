import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateRoleAndPermissionTables1779888377020 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE role (
        id          CHAR(36)     NOT NULL PRIMARY KEY,
        name        VARCHAR(64)  NOT NULL,
        description VARCHAR(255) NULL,
        created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT UC_ROLE_NAME UNIQUE (name)
      )
        COLLATE = utf8mb4_unicode_ci;
    `);

    await queryRunner.query(`
      CREATE TABLE permission (
        id          CHAR(36)     NOT NULL PRIMARY KEY,
        code        VARCHAR(64)  NOT NULL,
        description VARCHAR(255) NULL,
        created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT UC_PERMISSION_CODE UNIQUE (code)
      )
        COLLATE = utf8mb4_unicode_ci;
    `);

    await queryRunner.query(`
      CREATE TABLE role_permissions (
        role_id       CHAR(36) NOT NULL,
        permission_id CHAR(36) NOT NULL,
        PRIMARY KEY (role_id, permission_id),
        CONSTRAINT FK_ROLE_PERMISSIONS_ROLE FOREIGN KEY (role_id)
          REFERENCES role (id) ON DELETE CASCADE,
        CONSTRAINT FK_ROLE_PERMISSIONS_PERMISSION FOREIGN KEY (permission_id)
          REFERENCES permission (id) ON DELETE CASCADE
      )
        COLLATE = utf8mb4_unicode_ci;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE role_permissions;');
    await queryRunner.query('DROP TABLE permission;');
    await queryRunner.query('DROP TABLE role;');
  }
}
