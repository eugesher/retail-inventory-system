import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';

import { BaseTypeormRepository, entityManagerOf } from '@retail-inventory-system/database';

import { Refund } from '../../domain';
import { IRefundRepositoryPort, ITransactionScope } from '../../application/ports';
import { RefundEntity } from './refund.entity';
import { RefundMapper } from './refund.mapper';

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
    const reloaded = await repo.findOne({ where: { id: Number(saved.id) } });
    if (!reloaded) {
      throw new Error(`RefundTypeormRepository.save: refund ${saved.id} vanished after commit`);
    }
    return RefundMapper.toDomain(reloaded);
  }

  public async findByOrderId(orderId: number): Promise<Refund[]> {
    const entities = await this.refundRepository.find({
      where: { orderId },
      order: { issuedAt: 'DESC', id: 'DESC' },
    });
    return entities.map((entity) => RefundMapper.toDomain(entity));
  }

  public async findByPaymentId(paymentId: number, scope?: ITransactionScope): Promise<Refund[]> {
    const entities = await this.refundRepo(scope).find({
      where: { paymentId },
      order: { issuedAt: 'DESC', id: 'DESC' },
    });
    return entities.map((entity) => RefundMapper.toDomain(entity));
  }

  private refundRepo(scope?: ITransactionScope): Repository<RefundEntity> {
    if (!scope) {
      return this.refundRepository;
    }
    return entityManagerOf(scope).getRepository(RefundEntity);
  }
}
