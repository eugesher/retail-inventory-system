import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';

import { AddressOwnerTypeEnum } from '@retail-inventory-system/contracts';
import { BaseTypeormRepository } from '@retail-inventory-system/database';

import { Address } from '../../domain';
import { IAddressRepositoryPort } from '../../application/ports';
import { AddressEntity } from './address.entity';
import { AddressMapper } from './address.mapper';

// The single `@InjectRepository` site for the address aggregate. A single-row
// upsert by the caller-assigned CHAR(36) UUID PK — no transaction needed (no owned
// children). Returns domain types only — no TypeORM leak (ADR-017).
@Injectable()
export class AddressTypeormRepository
  extends BaseTypeormRepository<AddressEntity, Address>
  implements IAddressRepositoryPort
{
  constructor(
    @InjectRepository(AddressEntity)
    private readonly addressRepository: Repository<AddressEntity>,
  ) {
    super(addressRepository);
  }

  protected toDomain(entity: AddressEntity): Address {
    return AddressMapper.toDomain(entity);
  }

  protected toEntity(domain: Address): DeepPartial<AddressEntity> {
    return AddressMapper.toEntity(domain);
  }

  public async save(address: Address): Promise<Address> {
    const saved = await this.addressRepository.save(AddressMapper.toEntity(address));
    // Re-read so the returned aggregate carries the committed DB timestamps. The
    // row was just written, so a miss is an invariant breach.
    const reloaded = await this.findById(saved.id);
    if (!reloaded) {
      throw new Error(`AddressTypeormRepository.save: address ${saved.id} vanished after commit`);
    }
    return reloaded;
  }

  public async findById(id: string): Promise<Address | null> {
    const entity = await this.addressRepository.findOne({ where: { id } });
    return entity ? AddressMapper.toDomain(entity) : null;
  }

  public async findByOwner(ownerType: AddressOwnerTypeEnum, ownerId: string): Promise<Address[]> {
    const entities = await this.addressRepository.find({
      where: { ownerType, ownerId },
      order: { id: 'ASC' },
    });
    return entities.map((entity) => AddressMapper.toDomain(entity));
  }
}
