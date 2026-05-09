import { Module } from '@nestjs/common';

import { MicroserviceClientInventoryModule } from './microservice-client-inventory.module';
import { MicroserviceClientRetailModule } from './microservice-client-retail.module';

// Aggregate module convenience wrapper that exposes both retail and inventory
// RabbitMQ clients to whatever imports it. Apps that only need one client
// continue to import `MicroserviceClientRetailModule` /
// `MicroserviceClientInventoryModule` directly.
@Module({
  imports: [MicroserviceClientRetailModule, MicroserviceClientInventoryModule],
  exports: [MicroserviceClientRetailModule, MicroserviceClientInventoryModule],
})
export class MessagingModule {}
