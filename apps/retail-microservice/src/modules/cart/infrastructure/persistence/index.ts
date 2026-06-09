import { CartEntity } from './cart.entity';
import { CartLineEntity } from './cart-line.entity';

// A concrete entity array (spreadable) so retail `app.module.ts` can merge it with
// `orderEntities` into the one `DatabaseModule.forRoot([...])` connection.
export const cartEntities = [CartEntity, CartLineEntity];

export { CartEntity, CartLineEntity };
export * from './cart.mapper';
export * from './cart-line.mapper';
export * from './cart-typeorm.repository';
