import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';

import { BaseTypeormRepository } from '@retail-inventory-system/database';

import { Payment } from '../../domain';
import { IPaymentRepositoryPort } from '../../application/ports';
import { PaymentEntity } from './payment.entity';
import { PaymentMapper } from './payment.mapper';

// The single `@InjectRepository` site for the `Payment` aggregate. A single-row
// upsert (no owned children, no `@VersionColumn`), re-reading by id so the returned
// aggregate carries the generated BIGINT id + committed timestamps (the "re-read the
// saved graph" idiom the order/address repos follow). Returns domain types only — no
// TypeORM leak (ADR-017).
@Injectable()
export class PaymentTypeormRepository
  extends BaseTypeormRepository<PaymentEntity, Payment>
  implements IPaymentRepositoryPort
{
  constructor(
    @InjectRepository(PaymentEntity)
    private readonly paymentRepository: Repository<PaymentEntity>,
  ) {
    super(paymentRepository);
  }

  protected toDomain(entity: PaymentEntity): Payment {
    return PaymentMapper.toDomain(entity);
  }

  protected toEntity(domain: Payment): DeepPartial<PaymentEntity> {
    return PaymentMapper.toEntity(domain);
  }

  public async save(payment: Payment): Promise<Payment> {
    const saved = await this.paymentRepository.save(PaymentMapper.toEntity(payment));
    // Re-read so the returned aggregate carries the concrete generated id + the
    // committed DB timestamps. The row was just written, so a miss is an invariant
    // breach.
    const reloaded = await this.findById(Number(saved.id));
    if (!reloaded) {
      throw new Error(`PaymentTypeormRepository.save: payment ${saved.id} vanished after commit`);
    }
    return reloaded;
  }

  public async findById(id: number): Promise<Payment | null> {
    const entity = await this.paymentRepository.findOne({ where: { id } });
    return entity ? PaymentMapper.toDomain(entity) : null;
  }

  // One payment per order in this capability — returns the most recent defensively.
  public async findByOrderId(orderId: number): Promise<Payment | null> {
    const entity = await this.paymentRepository.findOne({
      where: { orderId },
      order: { id: 'DESC' },
    });
    return entity ? PaymentMapper.toDomain(entity) : null;
  }
}
