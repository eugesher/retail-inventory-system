import { ICorrelationPayload } from '../microservices';

export interface INotificationTemplateSetActivePayload extends ICorrelationPayload {
  id: number;
  active: boolean;
}
