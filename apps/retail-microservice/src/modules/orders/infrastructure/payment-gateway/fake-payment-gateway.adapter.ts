import { randomUUID } from 'crypto';

import { Injectable } from '@nestjs/common';

import {
  IPaymentAuthorizeRequest,
  IPaymentAuthorizeResult,
  IPaymentCaptureResult,
  IPaymentGatewayPort,
  IPaymentRefundResult,
} from '../../application/ports';

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

  public async capture(gatewayReference: string): Promise<IPaymentCaptureResult> {
    return Promise.resolve({
      captured: true,
      gatewayReference,
      capturedAt: new Date(),
    });
  }

  public async refund(): Promise<IPaymentRefundResult> {
    return Promise.resolve({
      refunded: true,
      gatewayReference: `fake_refund_${randomUUID()}`,
      refundedAt: new Date(),
    });
  }
}
