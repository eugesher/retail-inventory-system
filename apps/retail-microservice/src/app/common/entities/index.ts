import { TypeOrmModuleOptions } from '@nestjs/typeorm';

import { Customer } from './customer.entity';
import { Order } from './order.entity';
import { OrderProduct } from './order-product.entity';
import { OrderProductStatus } from './order-product-status.entity';
import { OrderStatus } from './order-status.entity';

export const entities: TypeOrmModuleOptions['entities'] = [
  Customer,
  Order,
  OrderProduct,
  OrderProductStatus,
  OrderStatus,
];

export { Customer, Order, OrderProduct, OrderProductStatus, OrderStatus };
