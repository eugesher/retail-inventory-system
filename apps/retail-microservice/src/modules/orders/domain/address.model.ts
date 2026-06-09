import { randomUUID } from 'crypto';

import { AddressOwnerTypeEnum } from '@retail-inventory-system/contracts';
import { AggregateRoot } from '@retail-inventory-system/ddd';

import { OrderDomainException, OrderErrorCodeEnum } from './order.exception';

export interface IAddressProps {
  id: string | null;
  ownerType: AddressOwnerTypeEnum;
  ownerId: string;
  recipientName: string;
  line1: string;
  line2?: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  phone?: string | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

// Input to the order-snapshot factory — the address fields the buyer supplied at
// place-time, plus the owning order's id. `ownerType` / `id` are set by the
// factory.
export interface IAddressForOrderInput {
  orderId: string;
  recipientName: string;
  line1: string;
  line2?: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  phone?: string | null;
}

// 2-letter ISO-3166 country code, upper-cased and validated so a malformed code
// never reaches the CHAR(2) column.
const COUNTRY_PATTERN = /^[A-Z]{2}$/;

// `Address` is a **polymorphic** aggregate root over `ownerType ∈ {customer,
// order}` (ADR-028 §5). Its id is a CHAR(36) UUID generated in-app at `forOrder`
// (caller-assigned, like the cart id), or reloaded on `reconstitute`.
//
// At place-time an order's billing and shipping addresses are **snapshot copies**
// written as immutable `ownerType = order` rows — copies of whatever the buyer
// supplied, never references into a (future) customer address book. The polymorphic
// `(ownerType, ownerId)` shape accepts the reusable `ownerType = customer`
// address-book entry from day one without a schema change, but this chain only
// produces `order` rows. An address is immutable once written (no setters); the
// inherited `deletedAt` stays inert.
export class Address extends AggregateRoot<string | null> {
  public readonly ownerType: AddressOwnerTypeEnum;
  public readonly ownerId: string;
  public readonly recipientName: string;
  public readonly line1: string;
  public readonly line2: string | null;
  public readonly city: string;
  public readonly region: string;
  public readonly postalCode: string;
  public readonly country: string;
  public readonly phone: string | null;
  public readonly createdAt: Date | null;
  public readonly updatedAt: Date | null;

  private constructor(props: IAddressProps) {
    if (!Object.values(AddressOwnerTypeEnum).includes(props.ownerType)) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ADDRESS_OWNER_TYPE_INVALID,
        `Address.ownerType must be one of ${Object.values(AddressOwnerTypeEnum).join(', ')}, got ${String(props.ownerType)}`,
      );
    }
    Address.requireNonEmpty(props.ownerId, OrderErrorCodeEnum.ADDRESS_OWNER_ID_REQUIRED, 'ownerId');
    Address.requireNonEmpty(
      props.recipientName,
      OrderErrorCodeEnum.ADDRESS_RECIPIENT_REQUIRED,
      'recipientName',
    );
    Address.requireNonEmpty(props.line1, OrderErrorCodeEnum.ADDRESS_LINE1_REQUIRED, 'line1');
    Address.requireNonEmpty(props.city, OrderErrorCodeEnum.ADDRESS_CITY_REQUIRED, 'city');
    Address.requireNonEmpty(props.region, OrderErrorCodeEnum.ADDRESS_REGION_REQUIRED, 'region');
    Address.requireNonEmpty(
      props.postalCode,
      OrderErrorCodeEnum.ADDRESS_POSTAL_CODE_REQUIRED,
      'postalCode',
    );

    // Normalise to upper-case, then validate the 2-letter ISO shape — `us` becomes
    // `US`; `USA` / `u` are rejected (wrong length).
    const country =
      typeof props.country === 'string' ? props.country.trim().toUpperCase() : props.country;
    if (typeof country !== 'string' || !COUNTRY_PATTERN.test(country)) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ADDRESS_COUNTRY_INVALID,
        `Address.country must be a 2-letter ISO code, got ${String(props.country)}`,
      );
    }

    super(props.id);
    this.ownerType = props.ownerType;
    this.ownerId = props.ownerId;
    this.recipientName = props.recipientName;
    this.line1 = props.line1;
    this.line2 = props.line2 ?? null;
    this.city = props.city;
    this.region = props.region;
    this.postalCode = props.postalCode;
    this.country = country;
    this.phone = props.phone ?? null;
    this.createdAt = props.createdAt ?? null;
    this.updatedAt = props.updatedAt ?? null;
  }

  // The place-time snapshot factory: writes an immutable `ownerType = order` row
  // owned by `orderId`, generating the CHAR(36) UUID in-app. (The `customer` owner
  // type is reserved for the later address-book capability and has no factory
  // here.)
  public static forOrder(input: IAddressForOrderInput): Address {
    return new Address({
      id: randomUUID(),
      ownerType: AddressOwnerTypeEnum.ORDER,
      ownerId: input.orderId,
      recipientName: input.recipientName,
      line1: input.line1,
      line2: input.line2 ?? null,
      city: input.city,
      region: input.region,
      postalCode: input.postalCode,
      country: input.country,
      phone: input.phone ?? null,
    });
  }

  // Rebuilds a persisted address from storage. Records no events.
  public static reconstitute(props: IAddressProps): Address {
    return new Address(props);
  }

  private static requireNonEmpty(value: string, code: OrderErrorCodeEnum, field: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new OrderDomainException(code, `Address.${field} must be a non-empty string`);
    }
  }
}
