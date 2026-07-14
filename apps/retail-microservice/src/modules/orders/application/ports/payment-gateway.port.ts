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

// The refund request. `gatewayReference` is the **captured** payment's opaque reference
// the refund reverses (a real processor refunds against the charge it created);
// `amountMinor` / `currency` describe the amount being returned (the Issue Refund use
// case has already validated it against the refundable ceiling); `correlationId` threads
// the request id for logging/tracing (ADR-001).
export interface IPaymentRefundRequest {
  gatewayReference: string;
  amountMinor: number;
  currency: string;
  correlationId?: string;
}

// The refund result. `refunded` is the gateway's verdict (the fake always succeeds);
// `gatewayReference` is a **fresh** opaque token for this refund interaction
// (`fake_refund_<uuid>` from the fake — distinct from the charge reference, the
// authorize/capture shape); `refundedAt` is the gateway's refund stamp.
export interface IPaymentRefundResult {
  refunded: boolean;
  gatewayReference: string;
  refundedAt: Date;
}

// The payment-gateway seam (ADR-028 §4). **The bound adapter is a fake that always approves**,
// mints deterministic tokens and makes no external call — so every decline path in this module is
// unreachable in practice, and a test that expects one will wait forever. Swapping in a real
// gateway (Stripe / PayPal — an excluded capability) is a single provider rebinding in
// `orders.module.ts` plus a new HTTP-doing adapter under
// `infrastructure/payment-gateway/`, with **no use-case change** — a real processor
// authorizes, captures, **and refunds** through the one seam, so `refund` joins the
// port rather than getting a parallel one.
//
// This is a domain/contract port — it carries **no transport / HTTP import** (ADR-004
// / ADR-017: `axios` and friends are infrastructure-only). The fake needs none; a
// real adapter confines its HTTP client to `infrastructure/`.
export interface IPaymentGatewayPort {
  authorize(req: IPaymentAuthorizeRequest): Promise<IPaymentAuthorizeResult>;
  capture(gatewayReference: string, correlationId?: string): Promise<IPaymentCaptureResult>;
  refund(req: IPaymentRefundRequest): Promise<IPaymentRefundResult>;
}
