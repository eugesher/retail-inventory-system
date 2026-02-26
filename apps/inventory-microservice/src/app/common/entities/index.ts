import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ProductStock } from './product-stock.entity';

export const entities: TypeOrmModuleOptions['entities'] = [ProductStock];

export { ProductStock };
