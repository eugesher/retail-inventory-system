import { ReturnDispositionEnum, ReturnLineConditionEnum } from '@retail-inventory-system/contracts';
import { Entity } from '@retail-inventory-system/ddd';

import { ReturnDomainException, ReturnErrorCodeEnum } from './return.exception';

export interface IReturnLineProps {
  id: number | null;
  // The owning request's BIGINT id — `null` until persistence assigns the parent (a
  // freshly built line on a freshly opened request), concrete after a load. A child
  // entity does not carry its parent's id in the persistence mapping (the relation
  // does), but the domain keeps it so a reconstituted line can be reasoned about
  // standalone (the `FulfillmentLine` precedent).
  returnRequestId: number | null;
  orderLineId: number;
  quantity: number;
  condition: ReturnLineConditionEnum | null;
  disposition: ReturnDispositionEnum | null;
  lineRefundAmountMinor: number | null;
}

// Input to the `inspect` mutator — the per-line outcome the warehouse records at
// inspection (the `inventory:receive-return` step). All three are required at inspect
// time: the condition the goods arrived in, what to do with them, and the refund
// amount this line earns.
export interface IInspectReturnLineInput {
  condition: ReturnLineConditionEnum;
  disposition: ReturnDispositionEnum;
  lineRefundAmountMinor: number;
}

// One line of a `ReturnRequest` and a *child entity* of the `ReturnRequest` aggregate
// root — never persisted or mutated on its own; the root holds and validates it (the
// `FulfillmentLine` / `OrderLine` precedent, ADR-028/031). It says which `OrderLine`
// quantity is coming back: a partial return carries fewer units than the line's
// ordered quantity.
//
// `orderLineId` is the opaque link back to the placed order's line; the FK that ties
// it to `order_line(id)` lives only in persistence — the line is plain domain data
// here (returns never imports the orders module). The `number | null` id mirrors
// `FulfillmentLine` / `OrderLine`: null before persistence assigns the BIGINT, concrete
// after a load.
//
// `condition` / `disposition` / `lineRefundAmountMinor` are **mutable once** — `null`
// from Open until inspection records them via `inspect(...)`. The line is therefore
// **not** `Object.freeze`d (unlike `OrderLine`): the inspection fields change exactly
// once, while `orderLineId` / `quantity` are fixed at Open. Records no events (a child
// entity, not an `AggregateRoot`).
export class ReturnLine extends Entity<number | null> {
  public readonly returnRequestId: number | null;
  public readonly orderLineId: number;
  public readonly quantity: number;
  private _condition: ReturnLineConditionEnum | null;
  private _disposition: ReturnDispositionEnum | null;
  private _lineRefundAmountMinor: number | null;

  constructor(props: IReturnLineProps) {
    // The model enforces only its own shape — the `quantity` invariant. Whether
    // `orderLineId` actually names a line on the order, and whether the Σ requested
    // quantity stays within the returnable remainder, are cross-aggregate checks the
    // Open use case owns (it resolves the order to validate them), not something the
    // standalone line can see (ADR-032).
    if (!Number.isInteger(props.quantity) || props.quantity <= 0) {
      throw new ReturnDomainException(
        ReturnErrorCodeEnum.RETURN_LINE_QUANTITY_INVALID,
        `ReturnLine.quantity must be a positive integer, got ${props.quantity}`,
      );
    }

    super(props.id);
    this.returnRequestId = props.returnRequestId;
    this.orderLineId = props.orderLineId;
    this.quantity = props.quantity;
    this._condition = props.condition;
    this._disposition = props.disposition;
    this._lineRefundAmountMinor = props.lineRefundAmountMinor;
  }

  public get condition(): ReturnLineConditionEnum | null {
    return this._condition;
  }

  public get disposition(): ReturnDispositionEnum | null {
    return this._disposition;
  }

  public get lineRefundAmountMinor(): number | null {
    return this._lineRefundAmountMinor;
  }

  // Records the inspection outcome — the condition the goods arrived in, the
  // disposition (restock/scrap/quarantine), and the refund amount this line earns.
  // Validates that the condition + disposition are real enum members and the refund
  // amount is a non-negative integer (minor units); any breach raises
  // `RETURN_INSPECTION_INVALID`. The parent-status walk (`received → inspected`) is the
  // `ReturnRequest.markInspected` mutator's job — this only records the per-line fields.
  public inspect(input: IInspectReturnLineInput): void {
    if (!Object.values(ReturnLineConditionEnum).includes(input.condition)) {
      throw new ReturnDomainException(
        ReturnErrorCodeEnum.RETURN_INSPECTION_INVALID,
        `ReturnLine.inspect: unknown condition '${input.condition}'`,
      );
    }
    if (!Object.values(ReturnDispositionEnum).includes(input.disposition)) {
      throw new ReturnDomainException(
        ReturnErrorCodeEnum.RETURN_INSPECTION_INVALID,
        `ReturnLine.inspect: unknown disposition '${input.disposition}'`,
      );
    }
    if (!Number.isInteger(input.lineRefundAmountMinor) || input.lineRefundAmountMinor < 0) {
      throw new ReturnDomainException(
        ReturnErrorCodeEnum.RETURN_INSPECTION_INVALID,
        `ReturnLine.inspect: lineRefundAmountMinor must be a non-negative integer, got ${input.lineRefundAmountMinor}`,
      );
    }

    this._condition = input.condition;
    this._disposition = input.disposition;
    this._lineRefundAmountMinor = input.lineRefundAmountMinor;
  }
}
