import { ICorrelationPayload } from '../microservices';

import { NotificationChannelEnum } from './enums';

export interface INotificationTemplateListPayload extends ICorrelationPayload {
  eventType?: string;
  channel?: NotificationChannelEnum;
  locale?: string;
}
