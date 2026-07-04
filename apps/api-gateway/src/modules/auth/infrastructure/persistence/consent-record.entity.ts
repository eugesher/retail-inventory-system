import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

// One customer's channel-consent row, 1:1 with `customer`. It deliberately does
// NOT extend `@retail-inventory-system/database`'s `BaseEntity`: the primary key
// is the customer's own CHAR(36) UUID (a caller-assigned PK, the `Reservation` /
// `idempotency_key` precedent), there is no surrogate auto-increment id, no
// `version`, no `created_at` / `deleted_at`. The only timestamp is `updated_at`
// (`@UpdateDateColumn`), stamped by MySQL on every write.
//
// The `customer_id` FK (`ON DELETE CASCADE`) + the composite-PK shape live in the
// migration (the source of truth with `synchronize` off — ADR-019). Per Q6 the
// customer row is never hard-deleted, so the CASCADE is a documented safety net,
// not a live path. SnakeNamingStrategy maps `customerId` → `customer_id`,
// `transactionalEmail` → `transactional_email`, `dataRetentionPolicy` →
// `data_retention_policy`, etc.
@Entity('consent_record')
export class ConsentRecordEntity {
  @PrimaryColumn('char', { length: 36 })
  public customerId: string;

  // Order-confirmation-style mail. Defaults true — transactional notifications
  // are operationally required.
  @Column({ type: 'boolean', default: true })
  public transactionalEmail: boolean;

  // Marketing channels default false (opt-in — the GDPR posture).
  @Column({ type: 'boolean', default: false })
  public marketingEmail: boolean;

  @Column({ type: 'boolean', default: false })
  public marketingSms: boolean;

  @Column({ type: 'varchar', length: 32, default: 'default-7-years' })
  public dataRetentionPolicy: string;

  @UpdateDateColumn()
  public updatedAt: Date;
}
