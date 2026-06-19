import { ReturnReasonCategoryEnum, ReturnStatusEnum } from '@retail-inventory-system/contracts';
import { AggregateRoot } from '@retail-inventory-system/ddd';

import { ReturnLine } from './return-line.model';
import { ReturnDomainException, ReturnErrorCodeEnum } from './return.exception';

export interface IReturnRequestProps {
  id: number | null;
  rmaNumber: string | null;
  orderId: number;
  // The gateway customer UUID (ADR-024) — the buyer, copied from the order. A CHAR(36)
  // string, mirroring `order.customer_id` (NOT a numeric id; the `order`/`order_line`
  // ids that bracket it ARE numeric BIGINTs, but the customer is the auth aggregate's
  // UUID). Non-null: a return always has a buyer.
  customerId: string;
  status?: ReturnStatusEnum;
  reasonCategory: ReturnReasonCategoryEnum;
  notes: string | null;
  requestedAt: Date;
  authorizedAt: Date | null;
  closedAt: Date | null;
  lines: ReturnLine[];
  version?: number;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

// Input to the `open` factory — the buyer-facing request path. `lines` carries the
// per-`OrderLine` quantities being returned; the factory builds the `ReturnLine`
// children from them (condition/disposition/refund all null until inspection). Status /
// rmaNumber / timestamps are set by the factory (always `REQUESTED` / null rmaNumber /
// `requestedAt = now`), never supplied.
export interface IOpenReturnRequestInput {
  orderId: number;
  customerId: string;
  reasonCategory: ReturnReasonCategoryEnum;
  notes: string | null;
  lines: { orderLineId: number; quantity: number }[];
}

// `ReturnRequest` is the RMA (Return Merchandise Authorization) record that drives a
// delivered/shipped order's return through a **six-state lifecycle** (ADR-032). It is
// the root of its **own bounded context** (`modules/returns/`), not a sibling
// aggregate inside `orders/`: the lifecycle is a substantial state machine with
// warehouse-facing operations (Receive, Inspect) distinct from order placement, so
// keeping it separate stops `orders/` from ballooning. By contrast `Refund` lives in
// `orders/` because its operations mutate `Payment` — the split is recorded in ADR-032.
//
// Its `status` walks `REQUESTED → AUTHORIZED → RECEIVED → INSPECTED → CLOSED`, with
// `REQUESTED → REJECTED` as the early-rejection branch; `REJECTED` and `CLOSED` are
// terminal. The id is the auto-increment BIGINT assigned by persistence (`null` until
// then, the `Order` / `Fulfillment` precedent), and `rmaNumber` is the human-facing
// `RMA-<year>-<pad8(id)>` finalized from that id post-persist (`null` until then — the
// `order_number` "re-read then finalize a derived field" idiom). `version` is the
// per-RMA optimistic-concurrency token: it ships and advances on every mutation now
// (the concurrency the cross-cutting consistency rule names), even though enforcement
// is a later hardening — retrofitting an OCC column onto a populated table is a
// destructive `ALTER`, so the column is cheapest up front (the ADR-028 §6 / ADR-027
// reasoning).
//
// **The aggregate enforces only its own shape** — ≥ 1 line, each line's quantity > 0,
// and the legal status transitions. The cross-line **returnable-quantity invariant**
// (Σ requested ≤ ordered − cancelled − already-returned) is **NOT** here: the aggregate
// cannot see the order's line quantities or sibling RMAs, so the **Open use case**
// enforces it (ADR-032). Records no domain events — the
// `retail.return.requested` event is built and emitted by the Open use case after
// persistence assigns ids + the RMA number (the `Order.place` / ADR-011 precedent).
export class ReturnRequest extends AggregateRoot<number | null> {
  private readonly _rmaNumber: string | null;
  private readonly _orderId: number;
  private readonly _customerId: string;
  private _status: ReturnStatusEnum;
  private readonly _reasonCategory: ReturnReasonCategoryEnum;
  private readonly _notes: string | null;
  private readonly _requestedAt: Date;
  private _authorizedAt: Date | null;
  private _closedAt: Date | null;
  private readonly _lines: ReturnLine[];
  private _version: number;
  public readonly createdAt: Date | null;
  public readonly updatedAt: Date | null;

  private constructor(props: IReturnRequestProps) {
    if (props.lines.length === 0) {
      throw new ReturnDomainException(
        ReturnErrorCodeEnum.RETURN_NO_LINES,
        'ReturnRequest must carry at least one line',
      );
    }

    super(props.id);
    this._rmaNumber = props.rmaNumber;
    this._orderId = props.orderId;
    this._customerId = props.customerId;
    this._status = props.status ?? ReturnStatusEnum.REQUESTED;
    this._reasonCategory = props.reasonCategory;
    this._notes = props.notes;
    this._requestedAt = props.requestedAt;
    this._authorizedAt = props.authorizedAt;
    this._closedAt = props.closedAt;
    this._lines = props.lines;
    this._version = props.version ?? 0;
    this.createdAt = props.createdAt ?? null;
    this.updatedAt = props.updatedAt ?? null;
  }

  // The buyer-request factory: validates ≥ 1 line, builds the `ReturnLine` children
  // (each enforcing its own positive-quantity invariant, all inspection fields null),
  // and opens the request `REQUESTED` at `version 0` with `requestedAt = now`, null
  // rmaNumber / authorizedAt / closedAt. `id` / each line's id are null until
  // persistence assigns the BIGINTs and finalizes the RMA number. Records no domain
  // event here — the Open use case emits `retail.return.requested` after the save
  // concretizes the ids (ADR-011 / ADR-032).
  public static open(input: IOpenReturnRequestInput, now: Date = new Date()): ReturnRequest {
    const lines = input.lines.map(
      (line) =>
        new ReturnLine({
          id: null,
          returnRequestId: null,
          orderLineId: line.orderLineId,
          quantity: line.quantity,
          condition: null,
          disposition: null,
          lineRefundAmountMinor: null,
        }),
    );
    return new ReturnRequest({
      id: null,
      rmaNumber: null,
      orderId: input.orderId,
      customerId: input.customerId,
      status: ReturnStatusEnum.REQUESTED,
      reasonCategory: input.reasonCategory,
      notes: input.notes,
      requestedAt: now,
      authorizedAt: null,
      closedAt: null,
      lines,
      version: 0,
    });
  }

  // Rebuilds a persisted return request from storage (any status / version). Records no
  // events.
  public static reconstitute(props: IReturnRequestProps): ReturnRequest {
    return new ReturnRequest(props);
  }

  public get rmaNumber(): string | null {
    return this._rmaNumber;
  }

  public get orderId(): number {
    return this._orderId;
  }

  public get customerId(): string {
    return this._customerId;
  }

  public get status(): ReturnStatusEnum {
    return this._status;
  }

  public get reasonCategory(): ReturnReasonCategoryEnum {
    return this._reasonCategory;
  }

  public get notes(): string | null {
    return this._notes;
  }

  public get requestedAt(): Date {
    return this._requestedAt;
  }

  public get authorizedAt(): Date | null {
    return this._authorizedAt;
  }

  public get closedAt(): Date | null {
    return this._closedAt;
  }

  public get lines(): readonly ReturnLine[] {
    return this._lines;
  }

  public get version(): number {
    return this._version;
  }

  // `REQUESTED → AUTHORIZED` (staff `order:return-authorize`). Stamps `authorizedAt`.
  // Bumps the OCC token. Rejects any non-`requested` start.
  public authorize(at: Date): void {
    this.assertStatus(ReturnStatusEnum.REQUESTED, 'authorize', `current: ${this._status}`);
    this._status = ReturnStatusEnum.AUTHORIZED;
    this._authorizedAt = at;
    this.bumpVersion();
  }

  // `REQUESTED → REJECTED` (staff `order:return-authorize`). Rejection is terminal, so
  // it stamps `closedAt` (the RMA never reaches the warehouse). Bumps the OCC token.
  public reject(at: Date): void {
    this.assertStatus(ReturnStatusEnum.REQUESTED, 'reject', `current: ${this._status}`);
    this._status = ReturnStatusEnum.REJECTED;
    this._closedAt = at;
    this.bumpVersion();
  }

  // `AUTHORIZED → RECEIVED` (warehouse `inventory:receive-return` logs the goods in).
  // Bumps the OCC token. Rejects any non-`authorized` start.
  public receive(): void {
    this.assertStatus(ReturnStatusEnum.AUTHORIZED, 'receive', `current: ${this._status}`);
    this._status = ReturnStatusEnum.RECEIVED;
    this.bumpVersion();
  }

  // `RECEIVED → INSPECTED` (warehouse records per-line condition + disposition). This
  // only walks the parent status; recording the per-line outcome is the use case's job
  // via `ReturnLine.inspect`. Bumps the OCC token. Rejects any non-`received` start.
  public markInspected(): void {
    this.assertStatus(ReturnStatusEnum.RECEIVED, 'markInspected', `current: ${this._status}`);
    this._status = ReturnStatusEnum.INSPECTED;
    this.bumpVersion();
  }

  // `INSPECTED → CLOSED` (staff settles the RMA — the refund, if any, is issued
  // alongside). Closure is terminal, so it stamps `closedAt`. Bumps the OCC token.
  // Rejects any non-`inspected` start.
  public close(at: Date): void {
    this.assertStatus(ReturnStatusEnum.INSPECTED, 'close', `current: ${this._status}`);
    this._status = ReturnStatusEnum.CLOSED;
    this._closedAt = at;
    this.bumpVersion();
  }

  // Shared transition guard — rejects an illegal start state with
  // `RETURN_INVALID_STATUS_TRANSITION` (409). Keeps each mutator a single expressive
  // line.
  private assertStatus(expected: ReturnStatusEnum, op: string, detail: string): void {
    if (this._status !== expected) {
      throw new ReturnDomainException(
        ReturnErrorCodeEnum.RETURN_INVALID_STATUS_TRANSITION,
        `ReturnRequest.${op}: can only ${op} a ${expected} return request (${detail})`,
      );
    }
  }

  // Every mutation advances the OCC token so "version bumps on each mutation" is
  // observable. Persistence delegates the stored value to TypeORM's `@VersionColumn`;
  // this in-memory bump keeps the domain self-describing (the `Order` / `Fulfillment`
  // precedent).
  private bumpVersion(): void {
    this._version += 1;
  }
}
