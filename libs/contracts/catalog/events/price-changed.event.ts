import { ICorrelationPayload } from '../../microservices';

export interface ICatalogPriceChangedEvent extends ICorrelationPayload {
  variantId: number;
  currency: string;
  amountMinor: number;
  validFrom: string;
  validTo: string | null;
  priority: number;
  eventVersion: 'v1';
  occurredAt: string;
}
