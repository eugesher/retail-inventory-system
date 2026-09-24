import { randomUUID } from 'crypto';

import { CartStatusEnum } from '@retail-inventory-system/contracts';
import { AggregateRoot } from '@retail-inventory-system/ddd';

import { CartLine } from './cart-line.model';
import { CartDomainException, CartErrorCodeEnum } from './cart.exception';
import {
  CartCreatedEvent,
  CartLineAddedEvent,
  CartLineQuantityChangedEvent,
  CartLineRemovedEvent,
} from './events';

export interface ICartProps {
  id: string | null;
  customerId: string | null;
  currency: string;
  status?: CartStatusEnum;
  lines?: CartLine[];
  expiresAt?: Date | null;
  version?: number;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

export interface IAddLineInput {
  variantId: number;
  quantity: number;
  unitPriceSnapshotMinor: number;
  currencySnapshot: string;
}

const CURRENCY_PATTERN = /^[A-Za-z]{3}$/;

export class Cart extends AggregateRoot<string | null> {
  private readonly _customerId: string | null;
  private readonly _currency: string;
  private _status: CartStatusEnum;
  private readonly _lines: CartLine[];
  private readonly _expiresAt: Date | null;
  private _version: number;
  public readonly createdAt: Date | null;
  public readonly updatedAt: Date | null;

  private constructor(props: ICartProps) {
    if (typeof props.currency !== 'string' || !CURRENCY_PATTERN.test(props.currency)) {
      throw new CartDomainException(
        CartErrorCodeEnum.CART_CURRENCY_INVALID,
        `Cart.currency must be a non-empty 3-letter code, got ${String(props.currency)}`,
      );
    }
    const version = props.version ?? 0;
    if (!Number.isInteger(version) || version < 0) {
      throw new CartDomainException(
        CartErrorCodeEnum.CART_VERSION_INVALID,
        `Cart.version must be a non-negative integer, got ${version}`,
      );
    }

    super(props.id);
    this._customerId = props.customerId;
    this._currency = props.currency;
    this._status = props.status ?? CartStatusEnum.ACTIVE;
    this._lines = props.lines ?? [];
    this._expiresAt = props.expiresAt ?? null;
    this._version = version;
    this.createdAt = props.createdAt ?? null;
    this.updatedAt = props.updatedAt ?? null;
  }

  public static create(props: {
    customerId: string | null;
    currency: string;
    expiresAt?: Date | null;
  }): Cart {
    const id = randomUUID();
    const cart = new Cart({
      id,
      customerId: props.customerId,
      currency: props.currency,
      status: CartStatusEnum.ACTIVE,
      lines: [],
      expiresAt: props.expiresAt ?? null,
      version: 0,
    });
    cart.addDomainEvent(
      new CartCreatedEvent({ cartId: id, customerId: props.customerId, currency: props.currency }),
    );
    return cart;
  }

  public static reconstitute(props: ICartProps): Cart {
    return new Cart(props);
  }

  public get customerId(): string | null {
    return this._customerId;
  }

  public get currency(): string {
    return this._currency;
  }

  public get status(): CartStatusEnum {
    return this._status;
  }

  public get lines(): readonly CartLine[] {
    return this._lines;
  }

  public get expiresAt(): Date | null {
    return this._expiresAt;
  }

  public get version(): number {
    return this._version;
  }

  public isActive(): boolean {
    return this._status === CartStatusEnum.ACTIVE;
  }

  public get total(): { subtotalMinor: number; currency: string } {
    const subtotalMinor = this._lines.reduce((sum, line) => sum + line.lineSubtotalMinor, 0);
    return { subtotalMinor, currency: this._currency };
  }

  public addLine(input: IAddLineInput): void {
    this.assertActive();

    const existing = this._lines.find((line) => line.variantId === input.variantId);
    if (existing) {
      existing.increaseQuantity(input.quantity);
    } else {
      this._lines.push(
        new CartLine({
          id: null,
          variantId: input.variantId,
          quantity: input.quantity,
          unitPriceSnapshotMinor: input.unitPriceSnapshotMinor,
          currencySnapshot: input.currencySnapshot,
        }),
      );
    }

    this.bumpVersion();
    this.addDomainEvent(
      new CartLineAddedEvent({
        cartId: this.requireId(),
        variantId: input.variantId,
        quantity: input.quantity,
      }),
    );
  }

  public changeLineQuantity(lineId: number, quantity: number): void {
    this.assertActive();
    const line = this.requireLine(lineId);
    line.changeQuantity(quantity);

    this.bumpVersion();
    this.addDomainEvent(
      new CartLineQuantityChangedEvent({ cartId: this.requireId(), lineId, quantity }),
    );
  }

  public removeLine(lineId: number): void {
    this.assertActive();
    const index = this._lines.findIndex((line) => line.id === lineId);
    if (index === -1) {
      throw new CartDomainException(
        CartErrorCodeEnum.CART_LINE_NOT_FOUND,
        `Cart.removeLine: no line with id ${lineId}`,
      );
    }
    this._lines.splice(index, 1);

    this.bumpVersion();
    this.addDomainEvent(new CartLineRemovedEvent({ cartId: this.requireId(), lineId }));
  }

  public markConverted(): void {
    this.transitionFromActive(CartStatusEnum.CONVERTED, 'markConverted');
  }

  public markAbandoned(): void {
    this.transitionFromActive(CartStatusEnum.ABANDONED, 'markAbandoned');
  }

  private transitionFromActive(next: CartStatusEnum, op: string): void {
    if (!this.isActive()) {
      throw new CartDomainException(
        CartErrorCodeEnum.CART_INVALID_STATE_TRANSITION,
        `Cart.${op}: only an active cart can transition (current status: ${this._status})`,
      );
    }
    this._status = next;
    this.bumpVersion();
  }

  private assertActive(): void {
    if (!this.isActive()) {
      throw new CartDomainException(
        CartErrorCodeEnum.CART_NOT_ACTIVE,
        `Cart: cannot mutate a cart that is not active (current status: ${this._status})`,
      );
    }
  }

  private requireLine(lineId: number): CartLine {
    const line = this._lines.find((candidate) => candidate.id === lineId);
    if (!line) {
      throw new CartDomainException(
        CartErrorCodeEnum.CART_LINE_NOT_FOUND,
        `Cart: no line with id ${lineId}`,
      );
    }
    return line;
  }

  private requireId(): string {
    if (this.id === null) {
      throw new Error('Cart: id is unexpectedly null on a live aggregate');
    }
    return this.id;
  }

  private bumpVersion(): void {
    this._version += 1;
  }
}
