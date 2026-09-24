import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';

import { BaseTypeormRepository } from '@retail-inventory-system/database';

import { ReturnRequest } from '../../domain';
import { IReturnRequestRepositoryPort } from '../../application/ports';
import { ReturnRequestEntity } from './return-request.entity';
import { ReturnRequestMapper } from './return-request.mapper';

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
      order: { lines: { id: 'ASC' } },
    });
    return entity ? ReturnRequestMapper.toDomain(entity) : null;
  }

  public async listByOrderId(orderId: number): Promise<ReturnRequest[]> {
    const entities = await this.returnRequestRepository.find({
      where: { orderId },
      relations: { lines: true },
      order: { requestedAt: 'DESC', id: 'DESC', lines: { id: 'ASC' } },
    });
    return entities.map((entity) => ReturnRequestMapper.toDomain(entity));
  }
}
