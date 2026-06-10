import { randomUUID } from 'crypto';

import { Injectable } from '@nestjs/common';

import {
  IPaymentAuthorizeRequest,
  IPaymentAuthorizeResult,
  IPaymentCaptureResult,
  IPaymentGatewayPort,
} from '../../application/ports';

// The default `PAYMENT_GATEWAY` binding (ADR-028 §4; the `LogNotifierAdapter`
// default-adapter precedent of ADR-011). A real payment processor (Stripe / PayPal /
// etc.) is an **excluded capability** — this in-process stand-in lets the Place Order
// and Capture use cases (later capabilities) exercise the full authorize → capture
// flow behind `IPaymentGatewayPort` without an external dependency.
//
// It **always approves**: `authorize` returns `approved: true` with a fresh
// `fake_<uuid>` reference and the caller's `method` (defaulting to `fake-card`);
// `capture` returns `captured: true` echoing the reference. No external calls, no
// persistence, no failure paths — deterministic and side-effect-free. Each
// `authorize` mints a distinct `gatewayReference` (the unique `payment.gateway_reference`
// column relies on it). Swapping in a real gateway is a single provider rebinding in
// `orders.module.ts` plus an HTTP-doing sibling adapter here — no use-case change.
@Injectable()
export class FakePaymentGatewayAdapter implements IPaymentGatewayPort {
  public async authorize(req: IPaymentAuthorizeRequest): Promise<IPaymentAuthorizeResult> {
    return Promise.resolve({
      approved: true,
      gatewayReference: `fake_${randomUUID()}`,
      method: req.method ?? 'fake-card',
      authorizedAt: new Date(),
    });
  }

  // The optional `correlationId` second param of `IPaymentGatewayPort.capture` is
  // omitted here — the fake makes no logged/traced call that would use it. A real
  // adapter implements the full arity.
  public async capture(gatewayReference: string): Promise<IPaymentCaptureResult> {
    return Promise.resolve({
      captured: true,
      gatewayReference,
      capturedAt: new Date(),
    });
  }
}
