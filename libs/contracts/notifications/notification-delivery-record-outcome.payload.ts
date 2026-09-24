import { ICorrelationPayload } from '../microservices';

export type NotificationDeliveryOutcome = 'delivered' | 'bounced';

export interface INotificationDeliveryRecordOutcomePayload extends ICorrelationPayload {
  deliveryId: number;
  outcome: NotificationDeliveryOutcome;
  failureReason?: string;
}
