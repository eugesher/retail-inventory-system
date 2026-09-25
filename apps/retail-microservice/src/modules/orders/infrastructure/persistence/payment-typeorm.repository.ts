import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';

import { PaymentStatusEnum } from '@retail-inventory-system/contracts';
import { BaseTypeormRepository, entityManagerOf } from '@retail-inventory-system/database';

import { Payment } from '../../domain';
import { IPaymentRepositoryPort, ITransactionScope } from '../../application/ports';
import { PaymentEntity } from './payment.entity';
import { PaymentMapper } from './payment.mapper';

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

  public async save(payment: Payment, scope?: ITransactionScope): Promise<Payment> {
    const repo = this.paymentRepo(scope);
    const saved = await repo.save(PaymentMapper.toEntity(payment));
    const reloaded = await repo.findOne({ where: { id: Number(saved.id) } });
    if (!reloaded) {
      throw new Error(`PaymentTypeormRepository.save: payment ${saved.id} vanished after commit`);
    }
    return PaymentMapper.toDomain(reloaded);
  }

  private paymentRepo(scope?: ITransactionScope): Repository<PaymentEntity> {
    if (!scope) {
      return this.paymentRepository;
    }
    return entityManagerOf(scope).getRepository(PaymentEntity);
  }

  public async findById(id: number): Promise<Payment | null> {
    const entity = await this.paymentRepository.findOne({ where: { id } });
    return entity ? PaymentMapper.toDomain(entity) : null;
  }

  public async findByOrderId(orderId: number, scope?: ITransactionScope): Promise<Payment | null> {
    const entity = await this.paymentRepo(scope).findOne({
      where: { orderId },
      order: { id: 'DESC' },
    });
    return entity ? PaymentMapper.toDomain(entity) : null;
  }

  public async findByOrderIdForUpdate(
    orderId: number,
    scope: ITransactionScope,
  ): Promise<Payment | null> {
    const entity = await this.paymentRepo(scope)
      .createQueryBuilder('payment')
      .setLock('pessimistic_write')
      .where('payment.order_id = :orderId', { orderId })
      .orderBy('payment.id', 'DESC')
      .getOne();
    return entity ? PaymentMapper.toDomain(entity) : null;
  }

  public async listStaleCaptureClaims(olderThan: Date): Promise<Payment[]> {
    const entities = await this.paymentRepo()
      .createQueryBuilder('payment')
      .where('payment.status = :status', { status: PaymentStatusEnum.CAPTURING })
      .andWhere('payment.updated_at < :olderThan', { olderThan })
      .orderBy('payment.updated_at', 'ASC')
      .getMany();
    return entities.map((entity) => PaymentMapper.toDomain(entity));
  }
}
