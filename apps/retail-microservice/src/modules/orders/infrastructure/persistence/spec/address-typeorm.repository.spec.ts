import { Repository } from 'typeorm';

import { AddressOwnerTypeEnum } from '@retail-inventory-system/contracts';

import { Address } from '../../../domain';
import { AddressEntity } from '../address.entity';
import { AddressMapper } from '../address.mapper';
import { AddressTypeormRepository } from '../address-typeorm.repository';

const addressEntity = (overrides: Partial<AddressEntity> = {}): AddressEntity =>
  ({
    id: 'addr-1',
    ownerType: AddressOwnerTypeEnum.ORDER,
    ownerId: '42',
    recipientName: 'Ada Lovelace',
    line1: '1 Analytical Engine Way',
    line2: null,
    city: 'London',
    region: 'Greater London',
    postalCode: 'EC1A 1BB',
    country: 'GB',
    phone: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  }) as AddressEntity;

describe('AddressMapper', () => {
  it('round-trips an address through domain → entity → domain', () => {
    const domain = Address.forOrder({
      orderId: '42',
      recipientName: 'Ada Lovelace',
      line1: '1 Analytical Engine Way',
      city: 'London',
      region: 'Greater London',
      postalCode: 'EC1A 1BB',
      country: 'gb',
    });

    const entity = AddressMapper.toEntity(domain);
    const back = AddressMapper.toDomain({ ...addressEntity(), ...entity } as AddressEntity);

    expect(back.ownerType).toBe(AddressOwnerTypeEnum.ORDER);
    expect(back.ownerId).toBe('42');
    expect(back.country).toBe('GB'); // upper-cased by the domain
  });
});

describe('AddressTypeormRepository', () => {
  let addressRepo: jest.Mocked<Pick<Repository<AddressEntity>, 'save' | 'findOne' | 'find'>>;
  let repository: AddressTypeormRepository;

  beforeEach(() => {
    jest.resetAllMocks();
    addressRepo = { save: jest.fn(), findOne: jest.fn(), find: jest.fn() } as never;
    repository = new AddressTypeormRepository(addressRepo as unknown as Repository<AddressEntity>);
  });

  describe('save', () => {
    it('upserts by the caller-assigned UUID and re-reads the committed row', async () => {
      const address = Address.forOrder({
        orderId: '42',
        recipientName: 'Ada Lovelace',
        line1: '1 Analytical Engine Way',
        city: 'London',
        region: 'Greater London',
        postalCode: 'EC1A 1BB',
        country: 'GB',
      });
      addressRepo.save.mockResolvedValue(addressEntity({ id: address.id! }));
      addressRepo.findOne.mockResolvedValue(addressEntity({ id: address.id! }));

      const result = await repository.save(address);

      expect(addressRepo.save).toHaveBeenCalledTimes(1);
      expect(result.id).toBe(address.id);
      expect(result.ownerType).toBe(AddressOwnerTypeEnum.ORDER);
    });

    // The invariant breach. The row was written one statement ago, inside the caller's transaction —
    // a miss on the re-read means the write did not land, and returning the in-memory aggregate would
    // hand Place Order an `Address` with **no row behind it**, which the order's
    // `billing_address_id` FK then points at. Loudly, or not at all.
    it('refuses to return an aggregate whose row vanished between the write and the re-read', async () => {
      const address = Address.forOrder({
        orderId: '42',
        recipientName: 'Ada Lovelace',
        line1: '1 Analytical Engine Way',
        city: 'London',
        region: 'Greater London',
        postalCode: 'EC1A 1BB',
        country: 'GB',
      });
      addressRepo.save.mockResolvedValue(addressEntity({ id: address.id! }));
      addressRepo.findOne.mockResolvedValue(null);

      await expect(repository.save(address)).rejects.toThrow('vanished after commit');
    });
  });

  // No read tests: the port is write-only (ADR-049). `findById` and `findByOwner` were
  // covered here and called by no use case; `findByOwner(CUSTOMER, id)` in particular
  // returned the customer address book the snapshot design rules out.
  //
  // **Which is also why `toDomain` / `toEntity` show as uncovered, and why that is not a gap to fill.**
  // They are `protected abstract` on `BaseTypeormRepository`, so the class must declare them — but this
  // class overrides `save` and the port exposes no read, so the base class's `find` / `save` (the only
  // callers of those two hooks) are never reached. Writing a test that calls the inherited `find` would
  // manufacture the number and legitimise a verb the port refuses on purpose; `softDelete`, inherited on
  // an immutable order snapshot, is the same hazard. The honest resolution is to stop extending
  // `BaseTypeormRepository` here — the append-only repositories already do exactly that, for exactly
  // this reason — but that is an architecture decision, not a coverage one.
});
