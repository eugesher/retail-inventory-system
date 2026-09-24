import { ICorrelationPayload } from '../microservices';

import { NotificationChannelEnum } from './enums';

export interface INotificationTemplateAuthorPayload extends ICorrelationPayload {
  eventType: string;
  channel: NotificationChannelEnum;
  locale: string;
  subject?: string;
  body: string;
}
