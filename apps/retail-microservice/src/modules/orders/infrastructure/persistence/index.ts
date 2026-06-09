import { AddressEntity } from './address.entity';
import { OrderEntity } from './order.entity';
import { OrderLineEntity } from './order-line.entity';

// A concrete entity array (spreadable) so retail `app.module.ts` can merge it with
// `cartEntities` into the one `DatabaseModule.forRoot([...])` connection.
export const orderEntities = [OrderEntity, OrderLineEntity, AddressEntity];

export { AddressEntity, OrderEntity, OrderLineEntity };
export * from './address.mapper';
export * from './address-typeorm.repository';
export * from './order.mapper';
export * from './order-line.mapper';
export * from './order-typeorm.repository';
