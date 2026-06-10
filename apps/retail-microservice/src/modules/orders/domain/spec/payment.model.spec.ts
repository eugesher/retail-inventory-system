import { PaymentStatusEnum } from '@retail-inventory-system/contracts';

import { IPaymentAuthorizedInput, Payment, OrderDomainException } from '..';

const authorizedInput = (): IPaymentAuthorizedInput => ({
  orderId: 1,
  amountMinor: 5997,
  currency: 'USD',
  method: 'fake-card',
  gatewayReference: 'fake_abc123',
  authorizedAt: new Date('2026-06-10T00:00:00Z'),
});

describe('Payment', () => {
  describe('authorized factory', () => {
    it('opens an AUTHORIZED payment with a null capturedAt and the authorize stamp', () => {
      const payment = Payment.authorized(authorizedInput());

      expect(payment.status).toBe(PaymentStatusEnum.AUTHORIZED);
      expect(payment.capturedAt).toBeNull();
      expect(payment.authorizedAt).toEqual(new Date('2026-06-10T00:00:00Z'));
      expect(payment.id).toBeNull();
      expect(payment.orderId).toBe(1);
      expect(payment.amountMinor).toBe(5997);
      expect(payment.currency).toBe('USD');
      expect(payment.method).toBe('fake-card');
      expect(payment.gatewayReference).toBe('fake_abc123');
    });

    it('rejects a non-positive orderId', () => {
      expect(() => Payment.authorized({ ...authorizedInput(), orderId: 0 })).toThrow(
        OrderDomainException,
      );
    });

    it.each([
      ['negative', -1],
      ['fractional', 12.5],
    ])('rejects a %s amountMinor', (_label, amountMinor) => {
      expect(() => Payment.authorized({ ...authorizedInput(), amountMinor })).toThrow(
        OrderDomainException,
      );
    });

    it('accepts a zero amountMinor (a free order is still a valid authorize)', () => {
      const payment = Payment.authorized({ ...authorizedInput(), amountMinor: 0 });
      expect(payment.amountMinor).toBe(0);
    });

    it.each([
      ['currency', { currency: '' }],
      ['method', { method: '' }],
      ['gatewayReference', { gatewayReference: '' }],
    ])('rejects an empty %s', (_label, override) => {
      expect(() => Payment.authorized({ ...authorizedInput(), ...override })).toThrow(
        OrderDomainException,
      );
    });
  });

  describe('capture', () => {
    it('transitions authorized → captured and stamps capturedAt', () => {
      const payment = Payment.authorized(authorizedInput());
      const at = new Date('2026-06-11T09:30:00Z');

      payment.capture(at);

      expect(payment.status).toBe(PaymentStatusEnum.CAPTURED);
      expect(payment.capturedAt).toEqual(at);
      // The authorize stamp is untouched by capture.
      expect(payment.authorizedAt).toEqual(new Date('2026-06-10T00:00:00Z'));
    });

    it('rejects capturing a payment that is not authorized (double-capture)', () => {
      const payment = Payment.authorized(authorizedInput());
      payment.capture(new Date());

      expect(() => payment.capture(new Date())).toThrow(OrderDomainException);
    });

    it('rejects capturing a reconstituted non-authorized payment', () => {
      const failed = Payment.reconstitute({
        id: 9,
        orderId: 1,
        amountMinor: 5997,
        currency: 'USD',
        method: 'fake-card',
        status: PaymentStatusEnum.FAILED,
        gatewayReference: 'fake_failed',
        authorizedAt: null,
        capturedAt: null,
      });

      expect(() => failed.capture(new Date())).toThrow(OrderDomainException);
    });
  });

  describe('reconstitute', () => {
    it('rebuilds a captured payment from storage', () => {
      const payment = Payment.reconstitute({
        id: 9,
        orderId: 1,
        amountMinor: 5997,
        currency: 'USD',
        method: 'fake-card',
        status: PaymentStatusEnum.CAPTURED,
        gatewayReference: 'fake_abc123',
        authorizedAt: new Date('2026-06-10T00:00:00Z'),
        capturedAt: new Date('2026-06-11T09:30:00Z'),
      });

      expect(payment.id).toBe(9);
      expect(payment.status).toBe(PaymentStatusEnum.CAPTURED);
      expect(payment.capturedAt).toEqual(new Date('2026-06-11T09:30:00Z'));
    });
  });
});
