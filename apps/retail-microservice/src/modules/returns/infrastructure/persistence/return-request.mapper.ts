import { DeepPartial } from 'typeorm';

import { ReturnRequest } from '../../domain';
import { ReturnRequestEntity } from './return-request.entity';
import { ReturnLineMapper } from './return-line.mapper';

export class ReturnRequestMapper {
  public static toEntity(domain: ReturnRequest): DeepPartial<ReturnRequestEntity> {
    const entity: DeepPartial<ReturnRequestEntity> = {
      rmaNumber: domain.rmaNumber,
      orderId: domain.orderId,
      customerId: domain.customerId,
      status: domain.status,
      reasonCategory: domain.reasonCategory,
      notes: domain.notes,
      requestedAt: domain.requestedAt,
      authorizedAt: domain.authorizedAt,
      closedAt: domain.closedAt,
    };

    if (domain.id !== null) {
      entity.id = domain.id;
    }

    return entity;
  }

  public static toDomain(entity: ReturnRequestEntity): ReturnRequest {
    const returnRequestId = Number(entity.id);
    return ReturnRequest.reconstitute({
      id: returnRequestId,
      rmaNumber: entity.rmaNumber ?? null,
      orderId: Number(entity.orderId),
      customerId: entity.customerId,
      status: entity.status,
      reasonCategory: entity.reasonCategory,
      notes: entity.notes ?? null,
      requestedAt: entity.requestedAt,
      authorizedAt: entity.authorizedAt ?? null,
      closedAt: entity.closedAt ?? null,
      lines: (entity.lines ?? []).map((line) => ReturnLineMapper.toDomain(line, returnRequestId)),
      version: Number(entity.version),
      createdAt: entity.createdAt ?? null,
      updatedAt: entity.updatedAt ?? null,
    });
  }
}
