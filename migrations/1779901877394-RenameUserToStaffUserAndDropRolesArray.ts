import { MigrationInterface, QueryRunner } from 'typeorm';

// Destructive on the `user` table by design — task-02 of epic-01 splits
// StaffUser (admin/catalog-manager/warehouse-staff/order-support) from
// Customer (task-05). The epic explicitly permits dropping `user` because
// nothing in the application depends on its preserved rows.
export class RenameUserToStaffUserAndDropRolesArray1779901877394 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE user;');

    await queryRunner.query(`
      CREATE TABLE staff_user (
        id                 CHAR(36)                       NOT NULL PRIMARY KEY,
        email              VARCHAR(255)                   NOT NULL,
        password_hash      VARCHAR(255)                   NOT NULL,
        status             ENUM('active', 'suspended')    NOT NULL DEFAULT 'active',
        last_login_at      TIMESTAMP                      NULL,
        refresh_token_hash VARCHAR(255)                   NULL,
        created_at         TIMESTAMP                      NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at         TIMESTAMP                      NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP,
        deleted_at         TIMESTAMP                      NULL,
        CONSTRAINT UC_STAFF_USER_EMAIL UNIQUE (email)
      )
        COLLATE = utf8mb4_unicode_ci;
    `);

    await queryRunner.query(`
      CREATE TABLE staff_user_roles (
        staff_user_id CHAR(36) NOT NULL,
        role_id       CHAR(36) NOT NULL,
        PRIMARY KEY (staff_user_id, role_id),
        CONSTRAINT FK_STAFF_USER_ROLES_USER FOREIGN KEY (staff_user_id)
          REFERENCES staff_user (id) ON DELETE CASCADE,
        CONSTRAINT FK_STAFF_USER_ROLES_ROLE FOREIGN KEY (role_id)
          REFERENCES role (id) ON DELETE CASCADE
      )
        COLLATE = utf8mb4_unicode_ci;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE staff_user_roles;');
    await queryRunner.query('DROP TABLE staff_user;');

    await queryRunner.query(`
      CREATE TABLE user (
        id                 CHAR(36)     NOT NULL PRIMARY KEY,
        email              VARCHAR(255) NOT NULL,
        password_hash      VARCHAR(255) NOT NULL,
        roles              VARCHAR(255) NOT NULL DEFAULT 'customer',
        refresh_token_hash VARCHAR(255) NULL,
        created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP,
        deleted_at         TIMESTAMP    NULL,
        CONSTRAINT UC_USER_EMAIL UNIQUE (email)
      )
        COLLATE = utf8mb4_unicode_ci;
    `);
  }
}
