import { Entity } from '@retail-inventory-system/ddd';

import { PricingDomainException, PricingErrorCodeEnum } from './pricing.exception';

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

export interface ISetPriceInput {
  variantId: number;
  currency: string;
  amountMinor: number;
  validFrom?: Date;
  validTo?: Date | null;
  priority?: number;
}

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

  public isOpen(): boolean {
    return this._validTo === null;
  }

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
