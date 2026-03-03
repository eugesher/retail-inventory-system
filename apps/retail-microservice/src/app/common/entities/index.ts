import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { Order } from './order.entity';

export const entities: TypeOrmModuleOptions['entities'] = [Order];

export { Order };
