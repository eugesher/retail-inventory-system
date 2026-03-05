import { TypeOrmModuleOptions } from '@nestjs/typeorm';

import { Order } from './order.entity';
import { OrderProduct } from './order-product.entity';

export const entities: TypeOrmModuleOptions['entities'] = [Order, OrderProduct];

export { Order, OrderProduct };
