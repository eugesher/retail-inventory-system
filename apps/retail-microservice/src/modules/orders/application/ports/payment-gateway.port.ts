export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

export interface IPaymentAuthorizeRequest {
  orderId: number;
  amountMinor: number;
  currency: string;
  method?: string;
  correlationId?: string;
}

export interface IPaymentAuthorizeResult {
  approved: boolean;
  gatewayReference: string;
  method: string;
  authorizedAt: Date;
}

export interface IPaymentCaptureResult {
  captured: boolean;
  gatewayReference: string;
  capturedAt: Date;
}

export interface IPaymentRefundRequest {
  gatewayReference: string;
  amountMinor: number;
  currency: string;
  correlationId?: string;
}

export interface IPaymentRefundResult {
  refunded: boolean;
  gatewayReference: string;
  refundedAt: Date;
}

export interface IPaymentGatewayPort {
  authorize(req: IPaymentAuthorizeRequest): Promise<IPaymentAuthorizeResult>;
  capture(gatewayReference: string, correlationId?: string): Promise<IPaymentCaptureResult>;
  refund(req: IPaymentRefundRequest): Promise<IPaymentRefundResult>;
}
