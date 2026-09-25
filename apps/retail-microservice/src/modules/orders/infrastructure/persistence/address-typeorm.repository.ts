import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';

import { BaseTypeormRepository, entityManagerOf } from '@retail-inventory-system/database';

import { Address } from '../../domain';
import { IAddressRepositoryPort, ITransactionScope } from '../../application/ports';
import { AddressEntity } from './address.entity';
import { AddressMapper } from './address.mapper';

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
    const reloaded = await repo.findOne({ where: { id: saved.id } });
    if (!reloaded) {
      throw new Error(`AddressTypeormRepository.save: address ${saved.id} vanished after commit`);
    }
    return AddressMapper.toDomain(reloaded);
  }

  private addressRepo(scope?: ITransactionScope): Repository<AddressEntity> {
    if (!scope) {
      return this.addressRepository;
    }
    return entityManagerOf(scope).getRepository(AddressEntity);
  }
}
