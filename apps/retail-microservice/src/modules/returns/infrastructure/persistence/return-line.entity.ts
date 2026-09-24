import { Column, Entity, JoinColumn, ManyToOne } from 'typeorm';

import { ReturnDispositionEnum, ReturnLineConditionEnum } from '@retail-inventory-system/contracts';
import { BaseEntity } from '@retail-inventory-system/database';

import { ReturnRequestEntity } from './return-request.entity';

@Entity('return_line')
export class ReturnLineEntity extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true })
  public orderLineId: number;

  @Column({ type: 'int' })
  public quantity: number;

  @Column({ type: 'enum', enum: ReturnLineConditionEnum, nullable: true })
  public condition: ReturnLineConditionEnum | null;

  @Column({ type: 'enum', enum: ReturnDispositionEnum, nullable: true })
  public disposition: ReturnDispositionEnum | null;

  @Column({ type: 'bigint', unsigned: true, nullable: true })
  public lineRefundAmountMinor: number | null;

  @ManyToOne(() => ReturnRequestEntity, (returnRequest) => returnRequest.lines, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'return_request_id' })
  public returnRequest: ReturnRequestEntity;
}
