import { ICorrelationPayload } from '../microservices';

import { NotificationDeliveryStatusEnum } from './enums';

export interface INotificationDeliveryListPayload extends ICorrelationPayload {
  customerId?: string;
  eventReferenceType?: string;
  eventReferenceId?: string;
  status?: NotificationDeliveryStatusEnum;
  page?: number;
  pageSize?: number;
}
