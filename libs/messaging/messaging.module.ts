import { Module } from '@nestjs/common';

import { MicroserviceClientInventoryModule } from './microservice-client-inventory.module';
import { MicroserviceClientRetailModule } from './microservice-client-retail.module';

@Module({
  imports: [MicroserviceClientRetailModule, MicroserviceClientInventoryModule],
  exports: [MicroserviceClientRetailModule, MicroserviceClientInventoryModule],
})
export class MessagingModule {}
