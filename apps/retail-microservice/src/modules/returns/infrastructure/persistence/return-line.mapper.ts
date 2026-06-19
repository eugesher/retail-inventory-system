import { DeepPartial } from 'typeorm';

import { ReturnLine } from '../../domain';
import { ReturnRequestEntity } from './return-request.entity';
import { ReturnLineEntity } from './return-line.entity';

export class ReturnLineMapper {
  // `returnRequestId` is supplied by the repository (the root's generated BIGINT id); a
  // return line never stands alone. The FK is set through the `returnRequest` relation
  // reference `{ id: returnRequestId }` — TypeORM writes `return_request_id` from it
  // without cascading to (or touching) the `return_request` table. Omit a null id so
  // TypeORM inserts the row; pass the concrete id so an existing line is updated (the
  // inspection columns advance at inspect-time). `condition` / `disposition` /
  // `lineRefundAmountMinor` are null until inspected.
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

  // The parent id is passed in (the repository knows it from the loaded root) rather
  // than read off `entity.returnRequest`, since the inverse relation is not populated
  // when the root is loaded with `relations: { lines: true }`. `order_line_id` and
  // `line_refund_amount_minor` are BIGINT — mysql2 returns non-PK BIGINTs as strings,
  // so coerce back to a number (preserving null for the nullable refund amount; the
  // order/stock-level mapper idiom).
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
