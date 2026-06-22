import { TypeOrmModuleOptions } from '@nestjs/typeorm';

import { NotificationDeliveryEntity } from './notification-delivery.entity';
import { NotificationTemplateEntity } from './notification-template.entity';

// The entity list wired into `DatabaseModule.forRoot(...)` at the notification
// `app.module.ts` (the inventory `stockEntities` shape). `notification_template` is
// listed first — `notification_delivery.template_id` FKs it.
export const notificationEntities: TypeOrmModuleOptions['entities'] = [
  NotificationTemplateEntity,
  NotificationDeliveryEntity,
];

export { NotificationTemplateEntity, NotificationDeliveryEntity };
export * from './notification-template.mapper';
export * from './notification-delivery.mapper';
export * from './notification-template-typeorm.repository';
export * from './notification-delivery-typeorm.repository';
