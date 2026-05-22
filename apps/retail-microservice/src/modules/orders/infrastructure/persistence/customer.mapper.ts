import { CustomerRef } from '../../domain';
import { Customer as CustomerEntity } from './customer.entity';

export class CustomerMapper {
  public static toDomain(entity: CustomerEntity): CustomerRef {
    return new CustomerRef({ id: entity.id });
  }
}
