import {
  IPage,
  NotificationChannelEnum,
  NotificationDeliveryStatusEnum,
  NotificationDeliveryView,
  NotificationTemplateView,
} from '@retail-inventory-system/contracts';

export const NOTIFICATIONS_GATEWAY_PORT = Symbol('NOTIFICATIONS_GATEWAY_PORT');

// Business-shaped command / query inputs for the gateway notifications port. They
// deliberately omit `correlationId` — that is a transport concern threaded
// separately through the controller and stitched onto the wire payload inside the
// adapter (the same split the inventory/catalog gateway ports follow). Each
// interface mirrors its `lib-contracts` RPC payload minus that one inherited field.

// Author a template version. Create-or-edit keyed on `(eventType, channel, locale)`
// — the notification service derives the next `version` and appends a fresh `active`
// row. `subject` is channel-specific (required for email/webhook, optional for
// sms/push); the domain has the final say (a subject-less email is a 400).
export interface IAuthorTemplateCommand {
  eventType: string;
  channel: NotificationChannelEnum;
  locale: string;
  subject?: string;
  body: string;
}

// Activate or deactivate one template **version** by id — the rollback lever.
export interface ISetTemplateActiveCommand {
  id: number;
  active: boolean;
}

// Registry browse: every field is an optional narrowing filter (absent ⇒ wider).
// Lists every version (active or not); the registry is small and unpaginated.
export interface IListTemplatesQuery {
  eventType?: string;
  channel?: NotificationChannelEnum;
  locale?: string;
}

// The paginated, filterable audit read of the delivery trail. `customerId` maps
// onto the row's `recipient_customer_id`; the rest scope to one business event /
// lifecycle state. `page` / `pageSize` are defaulted at the controller edge.
export interface IListDeliveriesQuery {
  customerId?: string;
  eventReferenceType?: string;
  eventReferenceId?: string;
  status?: NotificationDeliveryStatusEnum;
  page?: number;
  pageSize?: number;
}

// Single-row drill-down by id (incl. the materialized `renderedBody`).
export interface IGetDeliveryQuery {
  id: number;
}

// Operator manual retry of one **failed** delivery. Re-dispatches the row's
// already-rendered content, forcing past the scheduled sweeper's backoff gate.
export interface IRetryDeliveryCommand {
  deliveryId: number;
}

// The gateway-side seam onto the notification microservice's template + delivery
// RPCs (`notification.template.author` / `.set-active` / `.list`,
// `notification.delivery.list` / `.get` / `.retry`). The concrete implementation
// (`NotificationsRabbitmqAdapter`) is the only holder of a `ClientProxy`; use cases
// and the controller depend on this interface (ADR-009). Methods return the wire
// response DTOs from `lib-contracts` so the HTTP layer surfaces the notification
// service's own view shapes unchanged.
//
// NOTE: `notification.delivery.record-outcome` (the ESP-webhook seam) is
// deliberately **absent** — it has no gateway route this capability (real webhook
// ingestion, with signature verification + provider-payload mapping, is future
// work; the RPC stays RMQ-only).
export interface INotificationsGatewayPort {
  // Author (create-or-edit) a template version → the persisted `NotificationTemplateView`.
  authorTemplate(
    command: IAuthorTemplateCommand,
    correlationId: string,
  ): Promise<NotificationTemplateView>;
  // Activate / deactivate one version by id → the flipped `NotificationTemplateView`.
  // An unknown id is a 404 surfaced by the notification service's domain filter.
  setTemplateActive(
    command: ISetTemplateActiveCommand,
    correlationId: string,
  ): Promise<NotificationTemplateView>;
  // Filtered, unpaginated registry browse → every matching `NotificationTemplateView`.
  listTemplates(
    query: IListTemplatesQuery,
    correlationId: string,
  ): Promise<NotificationTemplateView[]>;
  // Paginated, newest-first audit read of the delivery trail → `IPage<NotificationDeliveryView>`.
  listDeliveries(
    query: IListDeliveriesQuery,
    correlationId: string,
  ): Promise<IPage<NotificationDeliveryView>>;
  // Single delivery row by id → `NotificationDeliveryView`. An unknown id is a 404.
  getDelivery(query: IGetDeliveryQuery, correlationId: string): Promise<NotificationDeliveryView>;
  // Manual retry of one failed delivery → the re-dispatched `NotificationDeliveryView`.
  // A non-`failed` source is a 409, an unknown id a 404, surfaced by the domain filter.
  retryDelivery(
    command: IRetryDeliveryCommand,
    correlationId: string,
  ): Promise<NotificationDeliveryView>;
}
