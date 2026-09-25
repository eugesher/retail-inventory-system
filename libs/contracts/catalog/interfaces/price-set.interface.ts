import { ICorrelationPayload } from '../../microservices';

export interface IPriceSetPayload extends ICorrelationPayload {
  variantId: number;
  currency: string;
  amountMinor: number;
  validFrom?: string;
  validTo?: string | null;
  priority?: number;
}
