import { ICorrelationPayload } from '../microservices';

export interface INotificationDeliveryGetPayload extends ICorrelationPayload {
  id: number;
}
