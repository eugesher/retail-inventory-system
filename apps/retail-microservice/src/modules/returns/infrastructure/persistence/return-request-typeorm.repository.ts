import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';

import { BaseTypeormRepository } from '@retail-inventory-system/database';

import { ReturnRequest } from '../../domain';
import { IReturnRequestRepositoryPort } from '../../application/ports';
import { ReturnRequestEntity } from './return-request.entity';
import { ReturnRequestMapper } from './return-request.mapper';

// The NON-transactional read side of the `ReturnRequest` aggregate (ADR-063), bound to the
// default connection via `@InjectRepository`. The write-capable half —
// `save`, and the in-transaction `findById` Inspect & Disposition needs — lives on
// `ReturnRequestWriteTypeormRepository`, constructed fresh per unit of work by
// `ReturnsUnitOfWorkAdapter`; this class never opens a transaction and never accepts one.
// Returns domain types only — no TypeORM leak past this file (ADR-017).
@Injectable()
export class ReturnRequestTypeormRepository
  extends BaseTypeormRepository<ReturnRequestEntity, ReturnRequest>
  implements IReturnRequestRepositoryPort
{
  constructor(
    @InjectRepository(ReturnRequestEntity)
    private readonly returnRequestRepository: Repository<ReturnRequestEntity>,
  ) {
    super(returnRequestRepository);
  }

  protected toDomain(entity: ReturnRequestEntity): ReturnRequest {
    return ReturnRequestMapper.toDomain(entity);
  }

  protected toEntity(domain: ReturnRequest): DeepPartial<ReturnRequestEntity> {
    return ReturnRequestMapper.toEntity(domain);
  }

  public async findById(id: number): Promise<ReturnRequest | null> {
    const entity = await this.returnRequestRepository.findOne({
      where: { id },
      relations: { lines: true },
      // Deterministic line order so the view is stable across reads.
      order: { lines: { id: 'ASC' } },
    });
    return entity ? ReturnRequestMapper.toDomain(entity) : null;
  }

  // An order's return requests, newest-first by `requested_at` then `id` (the
  // `(order_id, requested_at)` index supports it). Backs both the list read and the
  // Open use case's already-returned-quantity sum.
  public async listByOrderId(orderId: number): Promise<ReturnRequest[]> {
    const entities = await this.returnRequestRepository.find({
      where: { orderId },
      relations: { lines: true },
      order: { requestedAt: 'DESC', id: 'DESC', lines: { id: 'ASC' } },
    });
    return entities.map((entity) => ReturnRequestMapper.toDomain(entity));
  }
}
