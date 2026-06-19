import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, EntityManager, Repository } from 'typeorm';

import { BaseTypeormRepository } from '@retail-inventory-system/database';

import { Refund } from '../../domain';
import { IRefundRepositoryPort, ITransactionScope } from '../../application/ports';
import { RefundEntity } from './refund.entity';
import { RefundMapper } from './refund.mapper';

// The single `@InjectRepository` site for the `Refund` aggregate. A single-row upsert
// (no owned children, no `@VersionColumn`), re-reading by id so the returned aggregate
// carries the generated BIGINT id + committed timestamps (the "re-read the saved graph"
// idiom the payment/order repos follow). Returns domain types only — no TypeORM leak
// (ADR-017).
//
// `save` / `findById` / `findByPaymentId` are scope-aware so Issue Refund can persist
// the `Refund` and re-check/advance the `Payment` in one short follow-up transaction;
// `findByOrderId` is a default-manager read (the order-scoped history surfaces after
// commit).
@Injectable()
export class RefundTypeormRepository
  extends BaseTypeormRepository<RefundEntity, Refund>
  implements IRefundRepositoryPort
{
  constructor(
    @InjectRepository(RefundEntity)
    private readonly refundRepository: Repository<RefundEntity>,
  ) {
    super(refundRepository);
  }

  protected toDomain(entity: RefundEntity): Refund {
    return RefundMapper.toDomain(entity);
  }

  protected toEntity(domain: Refund): DeepPartial<RefundEntity> {
    return RefundMapper.toEntity(domain);
  }

  public async save(refund: Refund, scope?: ITransactionScope): Promise<Refund> {
    const repo = this.refundRepo(scope);
    const saved = await repo.save(RefundMapper.toEntity(refund));
    // Re-read (within the same scope when transactional) so the returned aggregate
    // carries the concrete generated id + the committed DB timestamps. The row was
    // just written, so a miss is an invariant breach.
    const reloaded = await repo.findOne({ where: { id: Number(saved.id) } });
    if (!reloaded) {
      throw new Error(`RefundTypeormRepository.save: refund ${saved.id} vanished after commit`);
    }
    return RefundMapper.toDomain(reloaded);
  }

  public async findById(id: number, scope?: ITransactionScope): Promise<Refund | null> {
    const entity = await this.refundRepo(scope).findOne({ where: { id } });
    return entity ? RefundMapper.toDomain(entity) : null;
  }

  // An order's refunds, newest-first by `issued_at` then `id` (a pending refund has a
  // null `issued_at`, so the `id` tiebreaker keeps the ordering total). The
  // order-scoped history read.
  public async findByOrderId(orderId: number): Promise<Refund[]> {
    const entities = await this.refundRepository.find({
      where: { orderId },
      order: { issuedAt: 'DESC', id: 'DESC' },
    });
    return entities.map((entity) => RefundMapper.toDomain(entity));
  }

  // A payment's refunds, newest-first — the per-payment history that backs the
  // over-refund guard at issue time (scope-aware so the guard reads the same
  // transaction Issue Refund writes in).
  public async findByPaymentId(paymentId: number, scope?: ITransactionScope): Promise<Refund[]> {
    const entities = await this.refundRepo(scope).find({
      where: { paymentId },
      order: { issuedAt: 'DESC', id: 'DESC' },
    });
    return entities.map((entity) => RefundMapper.toDomain(entity));
  }

  // Resolves the repository bound to the caller's transaction when a `scope` is
  // supplied (the `EntityManager` downcast ADR-017 §6 permits here), else the
  // default-manager repository.
  private refundRepo(scope?: ITransactionScope): Repository<RefundEntity> {
    if (!scope) {
      return this.refundRepository;
    }
    return (scope as unknown as EntityManager).getRepository(RefundEntity);
  }
}
