// An immutable row of the inventory audit ledger: a record of WHY a counter
// changed (ADR-030 §2). It is an **audit trail, NOT the balance authority** —
// ADR-027's `StockLevel` running totals remain the source of truth, and the sum of
// movement rows is deliberately NOT expected to reconstruct on-hand (an
// `allocation` and its cancelling `release` are BOTH negative by the per-type sign
// rule below, so they do not net to zero).
//
// Framework-free per ADR-004, and a fully **immutable** record in the `OrderLine`
// style: every field is `public readonly` and the constructed instance is
// `Object.freeze`-d, so append-only starts in the type system — there is no
// mutator that could ever change a recorded movement.
//
// `variantId` is an OPAQUE cross-service link to the catalog `product_variant`
// (the only coupling is the FK in persistence; the inventory domain MUST NOT
// import the catalog `ProductVariant` — ADR-004 / ADR-017 / ADR-027). `referenceId`
// is polymorphic and carries NO FK at all (the `MediaAsset` / retail `address`
// precedent, ADR-029).
//
// `StockMovementTypeEnum` is imported from `libs/contracts` because it is a WIRE
// enum (it rides the view, the audit query payload, and the future
// recorded-event); the domain may import `libs/{ddd,common,contracts}` (ADR-017).

import { StockMovementTypeEnum } from '@retail-inventory-system/contracts';

// Full reconstruction shape (the load path). `record` derives `id` / `occurredAt`
// and defaults the nullable fields, so its input is the narrower
// `IRecordStockMovementProps` below.
export interface IStockMovementProps {
  id: number | null;
  variantId: number;
  stockLocationId: string;
  type: StockMovementTypeEnum;
  quantity: number;
  reasonCode: string | null;
  referenceType: string | null;
  referenceId: string | null;
  actorId: string | null;
  occurredAt: Date;
}

export interface IRecordStockMovementProps {
  variantId: number;
  stockLocationId: string;
  type: StockMovementTypeEnum;
  quantity: number;
  reasonCode?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  actorId?: string | null;
  // Defaults to `new Date()` (now) on the write path; the load path always
  // supplies the stored instant.
  occurredAt?: Date;
}

// The movement types whose sign is fixed by the kind of change they record. The
// remaining type, `adjustment`, is the operator's signed delta and may be either
// sign (still non-zero).
const POSITIVE_TYPES: ReadonlySet<StockMovementTypeEnum> = new Set([
  StockMovementTypeEnum.RECEIPT,
  StockMovementTypeEnum.RETURN,
]);
const NEGATIVE_TYPES: ReadonlySet<StockMovementTypeEnum> = new Set([
  StockMovementTypeEnum.SALE,
  StockMovementTypeEnum.ALLOCATION,
  StockMovementTypeEnum.RELEASE,
]);

export class StockMovement {
  public readonly id: number | null;
  public readonly variantId: number;
  public readonly stockLocationId: string;
  public readonly type: StockMovementTypeEnum;
  public readonly quantity: number;
  public readonly reasonCode: string | null;
  public readonly referenceType: string | null;
  public readonly referenceId: string | null;
  public readonly actorId: string | null;
  public readonly occurredAt: Date;

  private constructor(props: IStockMovementProps) {
    // The sign-per-type invariant (ADR-030 §2). Movements are constructed by use
    // cases from already-validated counter changes, never from user input, so an
    // illegal sign is an INTERNAL bug — a plain `Error`, deliberately NOT a typed
    // `InventoryDomainException` the filter would surface as a client 4xx (the
    // `StockLevel.requireNonNegativeInt` precedent).
    StockMovement.requireSignForType(props.type, props.quantity);

    this.id = props.id;
    this.variantId = props.variantId;
    this.stockLocationId = props.stockLocationId;
    this.type = props.type;
    this.quantity = props.quantity;
    this.reasonCode = props.reasonCode;
    this.referenceType = props.referenceType;
    this.referenceId = props.referenceId;
    this.actorId = props.actorId;
    this.occurredAt = props.occurredAt;

    // `readonly` is a compile-time-only guard; freezing makes the immutability
    // real at runtime — any write throws in strict mode. This is the runtime half
    // of "append-only starts in the type system": a recorded movement can never be
    // mutated, only appended and listed (the `OrderLine` precedent).
    Object.freeze(this);
  }

  // The write path: a fresh movement with `id: null` (the BIGINT is DB-assigned on
  // append), `occurredAt` defaulting to now, and the nullable reference / reason /
  // actor fields defaulting to null when omitted.
  public static record(props: IRecordStockMovementProps): StockMovement {
    return new StockMovement({
      id: null,
      variantId: props.variantId,
      stockLocationId: props.stockLocationId,
      type: props.type,
      quantity: props.quantity,
      reasonCode: props.reasonCode ?? null,
      referenceType: props.referenceType ?? null,
      referenceId: props.referenceId ?? null,
      actorId: props.actorId ?? null,
      occurredAt: props.occurredAt ?? new Date(),
    });
  }

  // The load path: rebuilds a persisted movement from storage. The sign invariant
  // is re-asserted (a corrupted stored sign is rejected on read, the same defensive
  // posture `OrderLine` takes with its derived total).
  public static reconstitute(props: IStockMovementProps): StockMovement {
    return new StockMovement(props);
  }

  private static requireSignForType(type: StockMovementTypeEnum, quantity: number): void {
    if (!Number.isInteger(quantity) || quantity === 0) {
      throw new Error(`StockMovement: quantity must be a non-zero integer, got ${quantity}`);
    }
    if (POSITIVE_TYPES.has(type) && quantity < 0) {
      throw new Error(
        `StockMovement: a '${type}' movement must have a strictly positive quantity, got ${quantity}`,
      );
    }
    if (NEGATIVE_TYPES.has(type) && quantity > 0) {
      throw new Error(
        `StockMovement: a '${type}' movement must have a strictly negative quantity, got ${quantity}`,
      );
    }
    // `adjustment` accepts either sign — any non-zero integer is legal.
  }
}
