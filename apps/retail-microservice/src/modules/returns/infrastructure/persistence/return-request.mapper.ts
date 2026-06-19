import { DeepPartial } from 'typeorm';

import { ReturnRequest } from '../../domain';
import { ReturnRequestEntity } from './return-request.entity';
import { ReturnLineMapper } from './return-line.mapper';

export class ReturnRequestMapper {
  // Maps the root only — lines are persisted explicitly by the repository, so this
  // partial carries no `lines` array. `id` is omitted when null so TypeORM inserts;
  // present so it updates. `version` is intentionally NOT written — TypeORM's
  // `@VersionColumn` owns the persisted value (the same omission `OrderMapper` /
  // `FulfillmentMapper` make), so the managed optimistic-lock token is never raced by a
  // manual value. `rma_number` is carried here (null on a fresh open); the repository
  // finalizes it to `RMA-<year>-<pad8(id)>` via a targeted UPDATE once the id is known,
  // and strips it on a re-save (it is immutable thereafter).
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
    // The BIGINT PK comes back as a number; coerce defensively (mysql2 returns non-PK
    // BIGINTs as strings, and the lines need the concrete parent id). `customerId` is a
    // CHAR(36) string — no coercion.
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
      // `version` is INT, returned as a number; coerce defensively for parity.
      version: Number(entity.version),
      createdAt: entity.createdAt ?? null,
      updatedAt: entity.updatedAt ?? null,
    });
  }
}
