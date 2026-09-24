import { ICorrelationPayload } from '../../microservices';

export interface INotificationDeliveryFailedEvent extends ICorrelationPayload {
  deliveryId: number;
  eventReferenceType: string;
  eventReferenceId: string;
  failureReason: string;
  eventVersion: 'v1';
  occurredAt: string;
}
