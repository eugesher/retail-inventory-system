import { Column, Entity } from 'typeorm';

import { StockMovementTypeEnum } from '@retail-inventory-system/contracts';
import { BaseEntity } from '@retail-inventory-system/database';

@Entity('stock_movement')
export class StockMovementEntity extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true })
  public variantId: number;

  @Column({ type: 'varchar', length: 64 })
  public stockLocationId: string;

  @Column({ type: 'enum', enum: StockMovementTypeEnum })
  public type: StockMovementTypeEnum;

  @Column({ type: 'int' })
  public quantity: number;

  @Column({ type: 'varchar', length: 64, nullable: true })
  public reasonCode: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  public referenceType: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  public referenceId: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  public actorId: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  public operationKey: string | null;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  public occurredAt: Date;
}
