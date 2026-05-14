import { CustomerRef } from '../../domain';
import { Customer as CustomerEntity } from './customer.entity';

// Order owns its customer reference as a VO — the retail microservice does
// not maintain a Customer aggregate today (the `customer` table is read-only
// seed data). This mapper exists for the OrderCreatePipe / Customer-existence
// validation path, which only needs to confirm the id resolves.
export class CustomerMapper {
  public static toDomain(entity: CustomerEntity): CustomerRef {
    return new CustomerRef({ id: entity.id });
  }
}
