import { NotificationDeliveryEntity } from './notification-delivery.entity';
import { NotificationTemplateEntity } from './notification-template.entity';

export const notificationEntities = [NotificationTemplateEntity, NotificationDeliveryEntity];

export { NotificationTemplateEntity, NotificationDeliveryEntity };
export * from './notification-template.mapper';
export * from './notification-delivery.mapper';
export * from './notification-template-typeorm.repository';
export * from './notification-delivery-typeorm.repository';
export * from './consent-reader.adapter';
