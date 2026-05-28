import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { Customer } from '../../domain/customer.model';
import { CUSTOMER_REPOSITORY, ICustomerRepositoryPort } from '../ports/customer.repository.port';

@Injectable()
export class GetCurrentCustomerUseCase {
  constructor(@Inject(CUSTOMER_REPOSITORY) private readonly customers: ICustomerRepositoryPort) {}

  public async execute(id: string): Promise<Customer> {
    const customer = await this.customers.findById(id);
    if (!customer) {
      throw new NotFoundException('Customer not found');
    }
    return customer;
  }
}
