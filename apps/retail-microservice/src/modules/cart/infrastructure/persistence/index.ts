import { TypeOrmModuleOptions } from '@nestjs/typeorm';

import { CartEntity } from './cart.entity';
import { CartLineEntity } from './cart-line.entity';

export const cartEntities: TypeOrmModuleOptions['entities'] = [CartEntity, CartLineEntity];

export { CartEntity, CartLineEntity };
export * from './cart.mapper';
export * from './cart-line.mapper';
export * from './cart-typeorm.repository';
