import { TypeOrmModuleOptions } from '@nestjs/typeorm';

import { Order } from './order.entity';
import { OrderProduct } from './order-product.entity';
import { OrderProductStatus } from './order-product-status.entity';
import { OrderStatus } from './order-status.entity';

export const orderEntities: TypeOrmModuleOptions['entities'] = [
  Order,
  OrderProduct,
  OrderProductStatus,
  OrderStatus,
];

export { Order, OrderProduct, OrderProductStatus, OrderStatus };
export * from './order.mapper';
export * from './order-product.mapper';
export * from './order-typeorm.repository';
