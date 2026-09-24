import { Column, Entity, PrimaryColumn } from 'typeorm';

import { BaseEntity } from '@retail-inventory-system/database';

import { StockLocationTypeEnum } from '../../domain';

const StockLocationBaseEntity: abstract new () => Omit<BaseEntity, 'id'> = BaseEntity;

@Entity('stock_location')
export class StockLocationEntity extends StockLocationBaseEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  public id: string;

  @Column({ type: 'varchar', length: 255 })
  public name: string;

  @Column({ type: 'varchar', length: 64 })
  public code: string;

  @Column({
    type: 'enum',
    enum: StockLocationTypeEnum,
    default: StockLocationTypeEnum.WAREHOUSE,
  })
  public type: StockLocationTypeEnum;

  @Column({ type: 'json', nullable: true })
  public address: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 13, nullable: true })
  public gln: string | null;

  @Column({ type: 'boolean', default: true })
  public active: boolean;
}
