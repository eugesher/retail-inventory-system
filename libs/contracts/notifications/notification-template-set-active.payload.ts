import { ICorrelationPayload } from '../microservices';

// Wire-format command payload for `notification.template.set-active` (API Gateway →
// Notification). Carries a `correlationId` for log/trace correlation.
//
// Activate or deactivate one template **version** by id. Deactivating flips the row
// out of the "find latest active" resolution while keeping it on disk (soft-delete
// via the `active` flag, never `deletedAt`), so a rollback is "activate an earlier
// version". An unknown `id` surfaces `NOTIFICATION_TEMPLATE_NOT_FOUND` → 404.
export interface INotificationTemplateSetActivePayload extends ICorrelationPayload {
  id: number;
  active: boolean;
}
