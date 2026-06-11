import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, EntityManager, Repository } from 'typeorm';

import { AddressOwnerTypeEnum } from '@retail-inventory-system/contracts';
import { BaseTypeormRepository } from '@retail-inventory-system/database';

import { Address } from '../../domain';
import { IAddressRepositoryPort, ITransactionScope } from '../../application/ports';
import { AddressEntity } from './address.entity';
import { AddressMapper } from './address.mapper';

// The single `@InjectRepository` site for the address aggregate. A single-row
// upsert by the caller-assigned CHAR(36) UUID PK — no owned children. `save`
// accepts an optional `ITransactionScope` so Place Order writes both snapshot
// addresses inside the same transaction as the order + cart-conversion writes
// (ADR-017 §6). Returns domain types only — no TypeORM leak (ADR-017).
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

  public async save(address: Address, scope?: ITransactionScope): Promise<Address> {
    const repo = this.addressRepo(scope);
    const saved = await repo.save(AddressMapper.toEntity(address));
    // Re-read (within the same scope when transactional) so the returned aggregate
    // carries the committed DB timestamps. The row was just written, so a miss is an
    // invariant breach.
    const reloaded = await repo.findOne({ where: { id: saved.id } });
    if (!reloaded) {
      throw new Error(`AddressTypeormRepository.save: address ${saved.id} vanished after commit`);
    }
    return AddressMapper.toDomain(reloaded);
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

  // Resolves the repository bound to the caller's transaction when a `scope` is
  // supplied (the `EntityManager` downcast ADR-017 §6 permits here), else the
  // default-manager repository.
  private addressRepo(scope?: ITransactionScope): Repository<AddressEntity> {
    if (!scope) {
      return this.addressRepository;
    }
    return (scope as unknown as EntityManager).getRepository(AddressEntity);
  }
}
