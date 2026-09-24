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

export interface ICreateFulfillmentInput {
  orderId: number;
  stockLocationId: string;
  lines: { orderLineId: number; quantity: number }[];
}

export interface IShipFulfillmentInput {
  trackingNumber: string | null;
  carrier: string | null;
  shippedAt: Date;
}

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

  private bumpVersion(): void {
    this._version += 1;
  }
}
