export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

// The authorize request. `orderId` / `amountMinor` / `currency` describe the charge;
// `method` is an optional opaque method token from the caller (a tokenized card,
// wallet handle, etc. — the fake ignores it beyond echoing a default);
// `correlationId` threads the request id for logging/tracing (ADR-001).
export interface IPaymentAuthorizeRequest {
  orderId: number;
  amountMinor: number;
  currency: string;
  method?: string;
  correlationId?: string;
}

// The authorize result. `approved` is the gateway's verdict (the fake always
// approves); `gatewayReference` / `method` are the opaque tokens retail stores on
// the `Payment` row; `authorizedAt` is the gateway's authorize stamp.
export interface IPaymentAuthorizeResult {
  approved: boolean;
  gatewayReference: string;
  method: string;
  authorizedAt: Date;
}

// The capture result. `captured` is the gateway's verdict; `gatewayReference` echoes
// the authorized reference; `capturedAt` is the gateway's capture stamp.
export interface IPaymentCaptureResult {
  captured: boolean;
  gatewayReference: string;
  capturedAt: Date;
}

// The payment-gateway seam (ADR-028 §4, the `NotifierPort` default-adapter pattern
// of ADR-011). The Place Order and Capture use cases (later capabilities) depend
// only on this interface; the bound default is `FakePaymentGatewayAdapter`
// (always-approves, deterministic fake tokens, no external calls). Swapping in a
// real gateway (Stripe / PayPal / etc. — an excluded capability) is a single
// provider rebinding in `orders.module.ts` plus a new HTTP-doing adapter under
// `infrastructure/payment-gateway/`, with **no use-case change**.
//
// This is a domain/contract port — it carries **no transport / HTTP import** (ADR-004
// / ADR-017: `axios` and friends are infrastructure-only). The fake needs none; a
// real adapter confines its HTTP client to `infrastructure/`.
export interface IPaymentGatewayPort {
  authorize(req: IPaymentAuthorizeRequest): Promise<IPaymentAuthorizeResult>;
  capture(gatewayReference: string, correlationId?: string): Promise<IPaymentCaptureResult>;
}
