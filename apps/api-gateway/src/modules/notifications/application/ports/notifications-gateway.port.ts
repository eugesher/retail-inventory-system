import {
  IPage,
  NotificationChannelEnum,
  NotificationDeliveryStatusEnum,
  NotificationDeliveryView,
  NotificationTemplateView,
} from '@retail-inventory-system/contracts';

export type MarketingSendResult = NotificationDeliveryView | null;

export const NOTIFICATIONS_GATEWAY_PORT = Symbol('NOTIFICATIONS_GATEWAY_PORT');

export interface IAuthorTemplateCommand {
  eventType: string;
  channel: NotificationChannelEnum;
  locale: string;
  subject?: string;
  body: string;
}

export interface ISetTemplateActiveCommand {
  id: number;
  active: boolean;
}

export interface IListTemplatesQuery {
  eventType?: string;
  channel?: NotificationChannelEnum;
  locale?: string;
}

export interface IListDeliveriesQuery {
  customerId?: string;
  eventReferenceType?: string;
  eventReferenceId?: string;
  status?: NotificationDeliveryStatusEnum;
  page?: number;
  pageSize?: number;
}

export interface IGetDeliveryQuery {
  id: number;
}

export interface IRetryDeliveryCommand {
  deliveryId: number;
}

export interface ISendMarketingCommand {
  customerId: string;
  customerEmail: string;
  eventType: string;
  campaignId: string;
  context: Record<string, unknown>;
}

export interface INotificationsGatewayPort {
  authorTemplate(
    command: IAuthorTemplateCommand,
    correlationId: string,
  ): Promise<NotificationTemplateView>;
  setTemplateActive(
    command: ISetTemplateActiveCommand,
    correlationId: string,
  ): Promise<NotificationTemplateView>;
  listTemplates(
    query: IListTemplatesQuery,
    correlationId: string,
  ): Promise<NotificationTemplateView[]>;
  listDeliveries(
    query: IListDeliveriesQuery,
    correlationId: string,
  ): Promise<IPage<NotificationDeliveryView>>;
  getDelivery(query: IGetDeliveryQuery, correlationId: string): Promise<NotificationDeliveryView>;
  retryDelivery(
    command: IRetryDeliveryCommand,
    correlationId: string,
  ): Promise<NotificationDeliveryView>;
  sendMarketing(
    command: ISendMarketingCommand,
    correlationId: string,
  ): Promise<MarketingSendResult>;
}
