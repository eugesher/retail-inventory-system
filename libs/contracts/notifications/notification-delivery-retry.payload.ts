import { ICorrelationPayload } from '../microservices';

export interface INotificationDeliveryRetryPayload extends ICorrelationPayload {
  deliveryId: number;
}
