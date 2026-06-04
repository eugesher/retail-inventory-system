import { Entity } from '@retail-inventory-system/ddd';

import { PricingDomainException, PricingErrorCodeEnum } from './pricing.exception';

// ISO-4217 *shape* only — three uppercase letters. The domain does no currency
// lookup or rate conversion; it merely rejects an obviously malformed code.
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export interface IPriceProps {
  id: number | null;
  variantId: number;
  currency: string;
  amountMinor: number;
  validFrom: Date;
  validTo: Date | null;
  priority: number;
}

// The standard write path's input: `validFrom` defaults to "now" and `validTo`
// is open by default; `priority` defaults to 0. Everything else is required.
export interface ISetPriceInput {
  variantId: number;
  currency: string;
  amountMinor: number;
  validFrom?: Date;
  validTo?: Date | null;
  priority?: number;
}

// A `Price` is one row in an append-only-for-history ledger: a currency-scoped,
// time-bounded amount for a single variant. A price *change* is never an in-place
// value edit — it is a new row plus a close of the predecessor's open interval
// (see `close`), so the `[validFrom, validTo)` intervals form an auditable
// history per `(variantId, currency)` scope (ADR-026).
//
// `variantId` is an OPAQUE link. The pricing domain never imports the catalog
// `ProductVariant` — the only coupling is the FK in persistence (the
// forbidden-import rule, ADR-004/ADR-017). The id is `number | null`: null before
// persistence assigns one, concrete after `reconstitute`.
export class Price extends Entity<number | null> {
  private readonly _variantId: number;
  private readonly _currency: string;
  private readonly _amountMinor: number;
  private readonly _validFrom: Date;
  private readonly _validTo: Date | null;
  private readonly _priority: number;

  private constructor(props: IPriceProps) {
    if (!Number.isInteger(props.amountMinor) || props.amountMinor < 0) {
      throw new PricingDomainException(
        PricingErrorCodeEnum.PRICE_AMOUNT_INVALID,
        `Price.amountMinor must be a non-negative integer, got ${props.amountMinor}`,
      );
    }
    if (typeof props.currency !== 'string' || !CURRENCY_PATTERN.test(props.currency)) {
      throw new PricingDomainException(
        PricingErrorCodeEnum.PRICE_CURRENCY_INVALID,
        `Price.currency must match the ISO-4217 shape ^[A-Z]{3}$, got "${props.currency}"`,
      );
    }
    if (!Number.isInteger(props.priority)) {
      throw new PricingDomainException(
        PricingErrorCodeEnum.PRICE_PRIORITY_INVALID,
        `Price.priority must be an integer, got ${props.priority}`,
      );
    }
    if (props.validTo !== null && props.validFrom.getTime() >= props.validTo.getTime()) {
      throw new PricingDomainException(
        PricingErrorCodeEnum.PRICE_INTERVAL_INVALID,
        'Price interval is empty: validFrom must be strictly before validTo',
      );
    }

    super(props.id);
    this._variantId = props.variantId;
    this._currency = props.currency;
    this._amountMinor = props.amountMinor;
    this._validFrom = props.validFrom;
    this._validTo = props.validTo;
    this._priority = props.priority;
  }

  // The standard write path. `validFrom` defaults to `now`; a `validFrom`
  // strictly before `now` is rejected — set/schedule only open intervals at or
  // after now. Historical rows are never authored through this path; they arrive
  // only via `reconstitute` (loading from persistence) or `close` (the close of
  // an existing predecessor). `now` is injectable so specs are deterministic.
  public static set(input: ISetPriceInput, now: Date = new Date()): Price {
    const validFrom = input.validFrom ?? now;
    if (validFrom.getTime() < now.getTime()) {
      throw new PricingDomainException(
        PricingErrorCodeEnum.PRICE_VALID_FROM_IN_PAST,
        'Price.set: validFrom must not be strictly before now — author open intervals at or after now',
      );
    }

    return new Price({
      id: null,
      variantId: input.variantId,
      currency: input.currency,
      amountMinor: input.amountMinor,
      validFrom,
      validTo: input.validTo ?? null,
      priority: input.priority ?? 0,
    });
  }

  // Rebuilds a persisted row from storage — any `validFrom`, including the past,
  // is accepted (no "past" guard). This is also how the repository materializes
  // a closed predecessor. Records nothing.
  public static reconstitute(props: IPriceProps): Price {
    return new Price(props);
  }

  public get variantId(): number {
    return this._variantId;
  }

  public get currency(): string {
    return this._currency;
  }

  public get amountMinor(): number {
    return this._amountMinor;
  }

  public get validFrom(): Date {
    return this._validFrom;
  }

  public get validTo(): Date | null {
    return this._validTo;
  }

  public get priority(): number {
    return this._priority;
  }

  // An open row is the one currently in effect with no end — at most one per
  // `(variantId, currency)` scope (app-level close-in-transaction + a DB
  // generated-column UNIQUE backstop; ADR-026).
  public isOpen(): boolean {
    return this._validTo === null;
  }

  // The ONLY permitted mutation of an existing row: close its open interval at
  // `at`, returning a NEW `Price` carrying the same value fields. `amountMinor`,
  // `currency`, `variantId`, and `priority` are immutable once created — there is
  // no setter for them, because append-only-for-history means a value change is a
  // new row plus this close, never an edit. Closing at a time at-or-before
  // `validFrom` raises `PRICE_INTERVAL_INVALID` (an empty interval).
  public close(at: Date): Price {
    return Price.reconstitute({
      id: this.id,
      variantId: this._variantId,
      currency: this._currency,
      amountMinor: this._amountMinor,
      validFrom: this._validFrom,
      validTo: at,
      priority: this._priority,
    });
  }
}
