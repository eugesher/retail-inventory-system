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
  });

  describe('findByOwner', () => {
    it('resolves all addresses for an (ownerType, ownerId) pair', async () => {
      addressRepo.find.mockResolvedValue([addressEntity()]);

      const result = await repository.findByOwner(AddressOwnerTypeEnum.ORDER, '42');

      expect(result).toHaveLength(1);
      expect(addressRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { ownerType: AddressOwnerTypeEnum.ORDER, ownerId: '42' },
        }),
      );
    });
  });

  describe('findById', () => {
    it('returns null when no row matches', async () => {
      addressRepo.findOne.mockResolvedValue(null);
      await expect(repository.findById('missing')).resolves.toBeNull();
    });
  });
});
