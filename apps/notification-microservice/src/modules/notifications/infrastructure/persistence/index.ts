import { NotificationDeliveryEntity } from './notification-delivery.entity';
import { NotificationTemplateEntity } from './notification-template.entity';

// The module's entity list: `DatabaseModule.forRoot(...)` in `app.module.ts`, and
// `forFeature(...)` in the module file. UNANNOTATED on purpose — see the note on
// `DatabaseModule.forRoot` for why the parameter type must not be used here.
// `notification_template` is listed first — `notification_delivery.template_id` FKs it.
export const notificationEntities = [NotificationTemplateEntity, NotificationDeliveryEntity];

export { NotificationTemplateEntity, NotificationDeliveryEntity };
export * from './notification-template.mapper';
export * from './notification-delivery.mapper';
export * from './notification-template-typeorm.repository';
export * from './notification-delivery-typeorm.repository';
export * from './consent-reader.adapter';
