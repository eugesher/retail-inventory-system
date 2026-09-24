import { DeepPartial } from 'typeorm';

import { ReturnLine } from '../../domain';
import { ReturnRequestEntity } from './return-request.entity';
import { ReturnLineEntity } from './return-line.entity';

export class ReturnLineMapper {
  public static toEntity(
    domain: ReturnLine,
    returnRequestId: number,
  ): DeepPartial<ReturnLineEntity> {
    const entity: DeepPartial<ReturnLineEntity> = {
      returnRequest: { id: returnRequestId } as ReturnRequestEntity,
      orderLineId: domain.orderLineId,
      quantity: domain.quantity,
      condition: domain.condition,
      disposition: domain.disposition,
      lineRefundAmountMinor: domain.lineRefundAmountMinor,
    };

    if (domain.id !== null) {
      entity.id = domain.id;
    }

    return entity;
  }

  public static toDomain(entity: ReturnLineEntity, returnRequestId: number): ReturnLine {
    return new ReturnLine({
      id: entity.id === null || entity.id === undefined ? null : Number(entity.id),
      returnRequestId,
      orderLineId: Number(entity.orderLineId),
      quantity: entity.quantity,
      condition: entity.condition ?? null,
      disposition: entity.disposition ?? null,
      lineRefundAmountMinor:
        entity.lineRefundAmountMinor === null || entity.lineRefundAmountMinor === undefined
          ? null
          : Number(entity.lineRefundAmountMinor),
    });
  }
}
