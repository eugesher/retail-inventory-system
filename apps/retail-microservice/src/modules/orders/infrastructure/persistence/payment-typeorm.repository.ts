import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, EntityManager, Repository } from 'typeorm';

import { PaymentStatusEnum } from '@retail-inventory-system/contracts';
import { BaseTypeormRepository } from '@retail-inventory-system/database';

import { Payment } from '../../domain';
import { IPaymentRepositoryPort, ITransactionScope } from '../../application/ports';
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

  public async save(payment: Payment, scope?: ITransactionScope): Promise<Payment> {
    const repo = this.paymentRepo(scope);
    const saved = await repo.save(PaymentMapper.toEntity(payment));
    // Re-read (within the same scope when transactional) so the returned aggregate
    // carries the concrete generated id + the committed DB timestamps. The row was
    // just written, so a miss is an invariant breach.
    const reloaded = await repo.findOne({ where: { id: Number(saved.id) } });
    if (!reloaded) {
      throw new Error(`PaymentTypeormRepository.save: payment ${saved.id} vanished after commit`);
    }
    return PaymentMapper.toDomain(reloaded);
  }

  // Resolves the repository bound to the caller's transaction when a `scope` is
  // supplied (the `EntityManager` downcast ADR-017 §6 permits here), else the
  // default-manager repository.
  private paymentRepo(scope?: ITransactionScope): Repository<PaymentEntity> {
    if (!scope) {
      return this.paymentRepository;
    }
    return (scope as unknown as EntityManager).getRepository(PaymentEntity);
  }

  public async findById(id: number): Promise<Payment | null> {
    const entity = await this.paymentRepository.findOne({ where: { id } });
    return entity ? PaymentMapper.toDomain(entity) : null;
  }

  // One payment per order in this capability — returns the most recent defensively.
  // Scope-aware so a retried transaction (capture / ship / cancel, ADR-036) re-loads
  // the payment within its own attempt's transaction.
  public async findByOrderId(orderId: number, scope?: ITransactionScope): Promise<Payment | null> {
    const entity = await this.paymentRepo(scope).findOne({
      where: { orderId },
      order: { id: 'DESC' },
    });
    return entity ? PaymentMapper.toDomain(entity) : null;
  }

  // `SELECT … FOR UPDATE` — the mutual exclusion behind the capture claim (ADR-052). A
  // `pessimistic_write` lock is a **CURRENT** read: it waits for any in-flight writer of this row
  // and then sees what that writer committed, where the plain `findByOrderId` above would happily
  // serve this transaction's stale snapshot under REPEATABLE READ.
  //
  // That distinction is the whole fix. Both capture paths used to check `status === AUTHORIZED` on a
  // snapshot read and then charge the gateway; two of them could pass that check at once and charge
  // one authorization twice. Taking this lock, writing `CAPTURING` and committing **before** the
  // gateway call means the loser blocks here, wakes to a claimed payment, and never reaches the
  // processor.
  //
  // `scope` is required, not optional: `FOR UPDATE` outside a transaction releases at once and
  // guards nothing. The `ORDER BY id DESC` mirrors `findByOrderId` — an order has exactly one
  // payment, but the two reads must not be able to disagree about which row that is.
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

  // The stranded capture claims — `CAPTURING` rows nobody has touched since `olderThan`. A capture in
  // flight resolves in a gateway round-trip, so a claim minutes old is a crashed request, and the
  // money behind it may or may not have moved. **No lock and no scope: this read never leads to a
  // write.** It feeds an operator report (ADR-052).
  //
  // Ordered oldest-first so the report reads as a queue.
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
