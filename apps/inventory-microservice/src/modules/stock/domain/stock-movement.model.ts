// One immutable row of the inventory audit ledger — a record of **why** a counter changed
// (ADR-030 §2).
//
// **It is an audit trail, NOT the balance authority.** `StockLevel`'s running totals are the source
// of truth, and summing movement rows is deliberately **not** expected to reconstruct on-hand: an
// `allocation` and the `release` that cancels it are **both negative** under the sign rule below,
// so they do not net to zero. Anyone who tries to reconcile the ledger against the counters will
// find a discrepancy and will be looking at a feature.
//
// The record is **immutable at runtime, not just in the types**: every field is `readonly` and the
// instance is `Object.freeze`-d, so a recorded movement can be appended and listed and nothing
// else. `referenceId` is polymorphic and carries **no FK at all** — do not join on it.

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
  // The caller-minted identity of the operation that produced this row, when the operation
  // has no natural key of its own (ADR-057). Only Cancel-Allocation sets it today; every
  // other producer leaves it null, which keeps those rows out of the dedupe UNIQUE entirely.
  operationKey: string | null;
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
  // Optional: only an operation with no natural key supplies it (ADR-057).
  operationKey?: string | null;
  // Defaults to `new Date()` (now) on the write path; the load path always
  // supplies the stored instant.
  occurredAt?: Date;
}

// **The sign is fixed by the TYPE, and it is not the direction `available` moved.** A `release`
// raises `available` and is nonetheless recorded negative — which is exactly why the ledger does
// not reconcile against the counters (see the note at the top of this file). `adjustment` is the
// only type that may take either sign, and it may never be zero.
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
  public readonly operationKey: string | null;
  public readonly occurredAt: Date;

  private constructor(props: IStockMovementProps) {
    // A movement is built by a use case from a counter change that has *already* been validated —
    // never from user input. So a wrong sign here is an internal bug, and it is a plain `Error`
    // rather than a typed exception the filter would hand a caller as a 4xx.
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
    this.operationKey = props.operationKey;
    this.occurredAt = props.occurredAt;

    // `readonly` is compile-time only. Freezing makes it real: a write throws at runtime rather
    // than being caught by whoever happens to be type-checking.
    Object.freeze(this);
  }

  // The write path. `id` is `null` until the DB assigns it on append.
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
      operationKey: props.operationKey ?? null,
      occurredAt: props.occurredAt ?? new Date(),
    });
  }

  // The load path — and it **re-asserts the sign invariant on read**, not only on write. A row
  // whose stored sign contradicts its type is rejected coming out of the database, because a
  // corrupted ledger is worse than a missing one.
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
