import { DeepPartial } from 'typeorm';

import { Address } from '../../domain';
import { AddressEntity } from './address.entity';

export class AddressMapper {
  public static toEntity(domain: Address): DeepPartial<AddressEntity> {
    return {
      id: domain.id ?? undefined,
      ownerType: domain.ownerType,
      ownerId: domain.ownerId,
      recipientName: domain.recipientName,
      line1: domain.line1,
      line2: domain.line2,
      city: domain.city,
      region: domain.region,
      postalCode: domain.postalCode,
      country: domain.country,
      phone: domain.phone,
    };
  }

  public static toDomain(entity: AddressEntity): Address {
    return Address.reconstitute({
      id: entity.id,
      ownerType: entity.ownerType,
      ownerId: entity.ownerId,
      recipientName: entity.recipientName,
      line1: entity.line1,
      line2: entity.line2 ?? null,
      city: entity.city,
      region: entity.region,
      postalCode: entity.postalCode,
      country: entity.country,
      phone: entity.phone ?? null,
      createdAt: entity.createdAt ?? null,
      updatedAt: entity.updatedAt ?? null,
    });
  }
}
