import { FulfillmentStatusEnum } from '@retail-inventory-system/contracts';
import { AggregateRoot } from '@retail-inventory-system/ddd';

import { FulfillmentLine } from './fulfillment-line.model';
import { OrderDomainException, OrderErrorCodeEnum } from './order.exception';

export interface IFulfillmentProps {
  id: number | null;
  orderId: number;
  stockLocationId: string;
  status?: FulfillmentStatusEnum;
  trackingNumber: string | null;
  carrier: string | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  lines: FulfillmentLine[];
  version?: number;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

// Input to the `create` factory — the shipment-planning path. `lines` carries the
// per-`OrderLine` quantities the shipment includes; the factory builds the
// `FulfillmentLine` children from them. Status / tracking / timestamps are set by
// the factory (always `PENDING` / all null), never supplied.
export interface ICreateFulfillmentInput {
  orderId: number;
  stockLocationId: string;
  lines: { orderLineId: number; quantity: number }[];
}

// Input to the `ship` mutator. `trackingNumber` is required (the tracking-on-ship
// policy); `carrier` is optional metadata that may stay null.
export interface IShipFulfillmentInput {
  trackingNumber: string | null;
  carrier: string | null;
  shippedAt: Date;
}

// `Fulfillment` is the per-shipment, per-`stockLocationId` record that drives an
// order from `pending`/`authorized` toward `delivered` (ADR-031). It is a **sibling
// aggregate root** inside the `orders/` module — its operations act on `Order` and
// `Payment` (ship advances the order's fulfillment axis and captures payment), so it
// shares the bounded context and reuses `OrderDomainException` (the `Payment` /
// `Address` precedent, ADR-028 §4), rather than being a new module.
//
// Its `status` is a **fourth status axis** alongside the order's three orthogonal
// axes (ADR-028 §2): a `pending`/`shipped`/`delivered`/`cancelled` value that is
// *per shipment*. An order with split shipments owns several `Fulfillment`s, each
// with its own status; the order's own `fulfillment_status` is the roll-up across
// them (computed by the operations, not here).
//
// The id is the auto-increment BIGINT assigned by persistence (`null` until then),
// the `Order` / `Payment` precedent. `version` is the per-shipment
// optimistic-concurrency token: it ships and advances on every mutation now (the
// concurrency the cross-cutting consistency rule names), even though enforcement is
// a later hardening — retrofitting an OCC column onto a populated table is a
// destructive `ALTER`, so the column is cheapest up front (the ADR-028 §6 /
// ADR-027 reasoning).
//
// **The aggregate enforces only its own shape** — ≥ 1 line, each line's quantity > 0,
// the legal status transitions, and tracking-on-ship. The cross-fulfillment invariant
// (the per-`OrderLine` sum across all of an order's shipments ≤ the ordered quantity)
// is **NOT** here: the aggregate cannot see sibling fulfillments or the order's line
// quantities, so the **Create Fulfillment use case** enforces it (ADR-031). Records
// no domain events — the `retail.fulfillment.created` event is built and emitted by
// the Create use case after persistence assigns ids (the `Order.place` / ADR-011
// precedent).
export class Fulfillment extends AggregateRoot<number | null> {
  private readonly _orderId: number;
  private readonly _stockLocationId: string;
  private _status: FulfillmentStatusEnum;
  private _trackingNumber: string | null;
  private _carrier: string | null;
  private _shippedAt: Date | null;
  private _deliveredAt: Date | null;
  private readonly _lines: FulfillmentLine[];
  private _version: number;
  public readonly createdAt: Date | null;
  public readonly updatedAt: Date | null;

  private constructor(props: IFulfillmentProps) {
    if (props.lines.length === 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.FULFILLMENT_NO_LINES,
        'Fulfillment must carry at least one line',
      );
    }

    super(props.id);
    this._orderId = props.orderId;
    this._stockLocationId = props.stockLocationId;
    this._status = props.status ?? FulfillmentStatusEnum.PENDING;
    this._trackingNumber = props.trackingNumber;
    this._carrier = props.carrier;
    this._shippedAt = props.shippedAt;
    this._deliveredAt = props.deliveredAt;
    this._lines = props.lines;
    this._version = props.version ?? 0;
    this.createdAt = props.createdAt ?? null;
    this.updatedAt = props.updatedAt ?? null;
  }

  // The shipment-planning factory: validates ≥ 1 line, builds the `FulfillmentLine`
  // children (each enforcing its own positive-quantity invariant), and opens the
  // fulfillment `PENDING` at `version 0` with null tracking / carrier / timestamps.
  // `id` / each line's id are null until persistence assigns the BIGINTs. Records no
  // domain event here — the Create use case emits `retail.fulfillment.created` after
  // the save concretizes the ids (ADR-011 / ADR-031).
  public static create(input: ICreateFulfillmentInput): Fulfillment {
    const lines = input.lines.map(
      (line) =>
        new FulfillmentLine({
          id: null,
          fulfillmentId: null,
          orderLineId: line.orderLineId,
          quantity: line.quantity,
        }),
    );
    return new Fulfillment({
      id: null,
      orderId: input.orderId,
      stockLocationId: input.stockLocationId,
      status: FulfillmentStatusEnum.PENDING,
      trackingNumber: null,
      carrier: null,
      shippedAt: null,
      deliveredAt: null,
      lines,
      version: 0,
    });
  }

  // Rebuilds a persisted fulfillment from storage (any status / version). Records no
  // events.
  public static reconstitute(props: IFulfillmentProps): Fulfillment {
    return new Fulfillment(props);
  }

  public get orderId(): number {
    return this._orderId;
  }

  public get stockLocationId(): string {
    return this._stockLocationId;
  }

  public get status(): FulfillmentStatusEnum {
    return this._status;
  }

  public get trackingNumber(): string | null {
    return this._trackingNumber;
  }

  public get carrier(): string | null {
    return this._carrier;
  }

  public get shippedAt(): Date | null {
    return this._shippedAt;
  }

  public get deliveredAt(): Date | null {
    return this._deliveredAt;
  }

  public get lines(): readonly FulfillmentLine[] {
    return this._lines;
  }

  public get version(): number {
    return this._version;
  }

  // `PENDING → SHIPPED`. Requires a non-empty `trackingNumber` (the tracking-on-ship
  // policy — a shipment without a tracking number cannot be marked shipped); a
  // null/blank one raises `FULFILLMENT_TRACKING_REQUIRED` (400). Stamps `shippedAt`
  // and records the (optional) carrier. The state guard is primary — shipping a
  // non-`pending` fulfillment is an illegal transition (409) regardless of input.
  // Bumps the OCC token.
  public ship(input: IShipFulfillmentInput): void {
    if (this._status !== FulfillmentStatusEnum.PENDING) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.FULFILLMENT_INVALID_STATUS_TRANSITION,
        `Fulfillment.ship: can only ship a pending fulfillment (current: ${this._status})`,
      );
    }
    if (typeof input.trackingNumber !== 'string' || input.trackingNumber.trim().length === 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.FULFILLMENT_TRACKING_REQUIRED,
        'Fulfillment.ship: a tracking number is required to mark a shipment shipped',
      );
    }
    this._status = FulfillmentStatusEnum.SHIPPED;
    this._trackingNumber = input.trackingNumber;
    this._carrier = input.carrier;
    this._shippedAt = input.shippedAt;
    this.bumpVersion();
  }

  // `SHIPPED → DELIVERED`. Stamps `deliveredAt`. Rejects any non-`shipped` start
  // (a `pending` shipment has not left, a `delivered`/`cancelled` one is terminal).
  // Bumps the OCC token.
  public markDelivered(at: Date): void {
    if (this._status !== FulfillmentStatusEnum.SHIPPED) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.FULFILLMENT_INVALID_STATUS_TRANSITION,
        `Fulfillment.markDelivered: can only deliver a shipped fulfillment (current: ${this._status})`,
      );
    }
    this._status = FulfillmentStatusEnum.DELIVERED;
    this._deliveredAt = at;
    this.bumpVersion();
  }

  // `PENDING → CANCELLED`. A `shipped`/`delivered` fulfillment is **not** cancellable
  // — that is what protects Cancel Order's precondition (physically-shipped stock can
  // never be stranded by a cancellation). Cancellation is a status transition, never
  // a row delete — `fulfillment` is append-only. Bumps the OCC token.
  public cancel(): void {
    if (this._status !== FulfillmentStatusEnum.PENDING) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.FULFILLMENT_INVALID_STATUS_TRANSITION,
        `Fulfillment.cancel: can only cancel a pending fulfillment (current: ${this._status})`,
      );
    }
    this._status = FulfillmentStatusEnum.CANCELLED;
    this.bumpVersion();
  }

  // Every mutation advances the OCC token so "version bumps on each mutation" is
  // observable. Persistence delegates the stored value to TypeORM's `@VersionColumn`;
  // this in-memory bump keeps the domain self-describing (the `Order` precedent).
  private bumpVersion(): void {
    this._version += 1;
  }
}
