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

// Input for `addLine`: the variant + quantity plus the price snapshot captured
// at add-time. The line id and the owning cart id are not part of the input —
// id is assigned by persistence, the cart id is the root's own.
export interface IAddLineInput {
  variantId: number;
  quantity: number;
  unitPriceSnapshotMinor: number;
  currencySnapshot: string;
}

// 3-letter ISO-4217-shaped currency code (the cart currency + line snapshot
// currency). Validated here so a malformed code never reaches the CHAR(3) column.
const CURRENCY_PATTERN = /^[A-Za-z]{3}$/;

// `Cart` is the retail mutable aggregate root: the shopper's editable working set
// of `CartLine` children. It is the counterpart to the immutable `Order` snapshot
// — keeping the two distinct means a placed order can never be corrupted by a
// later edit of the (now-converted) cart (ADR-028 §1).
//
// The id is a CHAR(36) UUID string generated in-app at `create` (caller-assigned),
// or reloaded from the DB on `reconstitute`. The `string | null` generic matches
// the other aggregates' `<TId | null>` shape; in practice a live cart always
// carries a concrete id.
//
// `version` is the optimistic-concurrency token: it ships and advances on every
// mutation now, even though no concurrency guard consumes it yet — retrofitting an
// OCC column onto a populated table later is a destructive `ALTER TABLE`, so the
// column is cheapest up front (ADR-028 §6, the same reasoning ADR-027 used for
// `stock_level.version`).
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

  // Opens a new `active` cart with no lines at `version 0`, generating the
  // CHAR(36) UUID in-app, and records `CartCreatedEvent`. The id is concrete
  // immediately (unlike the catalog variant id, which is null until persistence),
  // so the recorded event carries the real cart id.
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

  // Rebuilds a persisted cart from storage (any status / version). Records no
  // events.
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

  // Pure subtotal projection (Σ `unitPriceSnapshotMinor × quantity`) for the cart
  // view. Money lives in minor units (integer cents); a cart never mixes
  // currencies, so the cart's own `currency` rides along.
  public get total(): { subtotalMinor: number; currency: string } {
    const subtotalMinor = this._lines.reduce((sum, line) => sum + line.lineSubtotalMinor, 0);
    return { subtotalMinor, currency: this._currency };
  }

  // Appends a line for `variantId`, or — if a line for that variant already
  // exists — increments the existing line's quantity (increment-existing is the
  // cleaner cart UX, ADR-028 §1). On the increment path the existing line's price
  // snapshot is preserved (the line is never re-priced); the incoming snapshot
  // fields are used only when a brand-new line is created. Records
  // `CartLineAddedEvent` carrying the quantity added in this call.
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

  // Sets a line's quantity to a new positive integer (`0` is rejected — removal
  // is the explicit op, enforced in `CartLine.changeQuantity`). Records
  // `CartLineQuantityChangedEvent`.
  public changeLineQuantity(lineId: number, quantity: number): void {
    this.assertActive();
    const line = this.requireLine(lineId);
    line.changeQuantity(quantity);

    this.bumpVersion();
    this.addDomainEvent(
      new CartLineQuantityChangedEvent({ cartId: this.requireId(), lineId, quantity }),
    );
  }

  // Drops the line with `lineId`. Records `CartLineRemovedEvent`.
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

  // active → converted. Called by Place Order (a later capability) once the cart's
  // lines are snapshotted into the order. Terminal; re-placing a converted cart is
  // an idempotency concern handled at the use-case layer, not here.
  public markConverted(): void {
    this.transitionFromActive(CartStatusEnum.CONVERTED, 'markConverted');
  }

  // active → abandoned. No producer yet — ships for the later purge capability.
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

  // A non-`active` cart is frozen — no line edits. (The terminal-state transition
  // methods raise `CART_INVALID_STATE_TRANSITION` instead, so the two rejection
  // reasons stay distinct for the HTTP mapping.)
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

  // A live cart (created or reconstituted) always carries a concrete id; a null
  // here is an invariant breach, not a domain rejection.
  private requireId(): string {
    if (this.id === null) {
      throw new Error('Cart: id is unexpectedly null on a live aggregate');
    }
    return this.id;
  }

  // Every mutation advances the OCC token so "version bumps on each mutation" is
  // observable. Persistence delegates the stored value to TypeORM's
  // `@VersionColumn`; this in-memory bump keeps the domain self-describing.
  private bumpVersion(): void {
    this._version += 1;
  }
}
