import { Module } from '@nestjs/common';

import { MicroserviceClientsModule } from '../../common/modules';
import { ProductController } from './product.controller';

@Module({
  imports: [MicroserviceClientsModule],
  controllers: [ProductController],
})
export class ProductModule {}
