import { AddressOwnerTypeEnum } from '@retail-inventory-system/contracts';

import { Address, OrderDomainException } from '..';

const forOrderProps = {
  orderId: '42',
  recipientName: 'Ada Lovelace',
  line1: '1 Analytical Engine Way',
  city: 'London',
  region: 'Greater London',
  postalCode: 'EC1A 1BB',
  country: 'GB',
};

describe('Address', () => {
  describe('forOrder', () => {
    it('writes an ownerType=order snapshot owned by the order id, with a generated UUID', () => {
      const address = Address.forOrder(forOrderProps);

      expect(address.ownerType).toBe(AddressOwnerTypeEnum.ORDER);
      expect(address.ownerId).toBe('42');
      expect(typeof address.id).toBe('string');
      expect(address.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('defaults the optional line2 and phone to null', () => {
      const address = Address.forOrder(forOrderProps);
      expect(address.line2).toBeNull();
      expect(address.phone).toBeNull();
    });
  });

  describe('country', () => {
    it('upper-cases a 2-letter code', () => {
      const address = Address.forOrder({ ...forOrderProps, country: 'us' });
      expect(address.country).toBe('US');
    });

    it.each([
      ['three letters', 'USA'],
      ['one letter', 'u'],
      ['empty', ''],
    ])('rejects a %s country', (_label, country) => {
      expect(() => Address.forOrder({ ...forOrderProps, country })).toThrow(OrderDomainException);
    });
  });

  describe('ownerType', () => {
    it('accepts the two enum values on the load path', () => {
      const customer = Address.reconstitute({
        id: 'addr-1',
        ownerType: AddressOwnerTypeEnum.CUSTOMER,
        ownerId: 'cust-1',
        recipientName: 'Ada',
        line1: '1 Way',
        city: 'London',
        region: 'London',
        postalCode: 'EC1',
        country: 'GB',
      });
      expect(customer.ownerType).toBe(AddressOwnerTypeEnum.CUSTOMER);
    });

    it('rejects an unknown ownerType', () => {
      expect(() =>
        Address.reconstitute({
          id: 'addr-1',
          ownerType: 'warehouse' as AddressOwnerTypeEnum,
          ownerId: 'x',
          recipientName: 'Ada',
          line1: '1 Way',
          city: 'London',
          region: 'London',
          postalCode: 'EC1',
          country: 'GB',
        }),
      ).toThrow(OrderDomainException);
    });
  });

  describe('required fields', () => {
    it.each([
      ['recipientName', { recipientName: '' }],
      ['line1', { line1: '   ' }],
      ['city', { city: '' }],
      ['region', { region: '' }],
      ['postalCode', { postalCode: '' }],
    ])('rejects an empty %s', (_label, override) => {
      expect(() => Address.forOrder({ ...forOrderProps, ...override })).toThrow(
        OrderDomainException,
      );
    });
  });
});
