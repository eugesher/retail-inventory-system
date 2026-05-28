import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ICustomerRepositoryPort } from '../../application/ports/customer.repository.port';
import { Customer } from '../../domain/customer.model';
import { CustomerEntity } from './customer.entity';
import { CustomerMapper } from './customer.mapper';

@Injectable()
export class CustomerTypeormRepository implements ICustomerRepositoryPort {
  constructor(
    @InjectRepository(CustomerEntity)
    private readonly repository: Repository<CustomerEntity>,
  ) {}

  public async findByEmail(email: string): Promise<Customer | null> {
    const entity = await this.repository.findOne({
      where: { email: email.toLowerCase() },
    });
    return entity ? CustomerMapper.toDomain(entity) : null;
  }

  public async findById(id: string): Promise<Customer | null> {
    const entity = await this.repository.findOne({ where: { id } });
    return entity ? CustomerMapper.toDomain(entity) : null;
  }

  public async save(customer: Customer): Promise<Customer> {
    const partial = CustomerMapper.toEntity(customer);
    await this.repository.save(partial);
    const reloaded = await this.repository.findOne({ where: { id: customer.id } });
    if (!reloaded) {
      throw new Error(`CustomerTypeormRepository.save: lost row id=${customer.id} after upsert`);
    }
    return CustomerMapper.toDomain(reloaded);
  }
}
