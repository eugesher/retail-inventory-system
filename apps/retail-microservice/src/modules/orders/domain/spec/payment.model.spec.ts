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
      expect(payment.flaggedForRefund).toBe(false);
      expect(payment.refundedAmountMinor).toBe(0);
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

  const captured = (): Payment => {
    const payment = Payment.authorized(authorizedInput());
    payment.beginCapture();
    payment.completeCapture(new Date('2026-06-11T09:30:00Z'));
    return payment;
  };

  describe('capture claim', () => {
    it('beginCapture transitions authorized → capturing without stamping capturedAt', () => {
      const payment = Payment.authorized(authorizedInput());

      payment.beginCapture();

      expect(payment.status).toBe(PaymentStatusEnum.CAPTURING);
      expect(payment.capturedAt).toBeNull();
    });

    it('completeCapture transitions capturing → captured and stamps capturedAt', () => {
      const payment = Payment.authorized(authorizedInput());
      const at = new Date('2026-06-11T09:30:00Z');

      payment.beginCapture();
      payment.completeCapture(at);

      expect(payment.status).toBe(PaymentStatusEnum.CAPTURED);
      expect(payment.capturedAt).toEqual(at);
      expect(payment.authorizedAt).toEqual(new Date('2026-06-10T00:00:00Z'));
    });

    it('releaseCapture returns a declined claim to authorized, still capturable', () => {
      const payment = Payment.authorized(authorizedInput());

      payment.beginCapture();
      payment.releaseCapture();

      expect(payment.status).toBe(PaymentStatusEnum.AUTHORIZED);
      expect(payment.capturedAt).toBeNull();
      expect(() => payment.beginCapture()).not.toThrow();
    });

    it('rejects a SECOND claim on an already-claimed payment (the double-charge guard)', () => {
      const payment = Payment.authorized(authorizedInput());
      payment.beginCapture();

      expect(() => payment.beginCapture()).toThrow(OrderDomainException);
      expect(payment.status).toBe(PaymentStatusEnum.CAPTURING);
    });

    it('rejects claiming an already-captured payment (double-capture)', () => {
      expect(() => captured().beginCapture()).toThrow(OrderDomainException);
    });

    it('rejects completing a capture nobody claimed', () => {
      const payment = Payment.authorized(authorizedInput());

      expect(() => payment.completeCapture(new Date())).toThrow(OrderDomainException);
    });

    it('rejects releasing a claim nobody holds', () => {
      const payment = Payment.authorized(authorizedInput());

      expect(() => payment.releaseCapture()).toThrow(OrderDomainException);
    });

    it('rejects claiming a reconstituted non-authorized payment', () => {
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

      expect(() => failed.beginCapture()).toThrow(OrderDomainException);
    });

    it('rejects voiding a payment whose capture is in flight', () => {
      const payment = Payment.authorized(authorizedInput());
      payment.beginCapture();

      expect(() => payment.void()).toThrow(OrderDomainException);
    });
  });

  describe('void', () => {
    it('transitions authorized → voided', () => {
      const payment = Payment.authorized(authorizedInput());

      payment.void();

      expect(payment.status).toBe(PaymentStatusEnum.VOIDED);
      expect(payment.capturedAt).toBeNull();
    });

    it('rejects voiding a captured payment', () => {
      const payment = Payment.authorized(authorizedInput());
      payment.beginCapture();
      payment.completeCapture(new Date());

      expect(() => payment.void()).toThrow(OrderDomainException);
    });

    it('rejects voiding an already-voided payment', () => {
      const payment = Payment.authorized(authorizedInput());
      payment.void();

      expect(() => payment.void()).toThrow(OrderDomainException);
    });
  });

  describe('flagForRefund', () => {
    it('sets the refund flag on a captured payment', () => {
      const payment = Payment.authorized(authorizedInput());
      payment.beginCapture();
      payment.completeCapture(new Date());

      payment.flagForRefund();

      expect(payment.flaggedForRefund).toBe(true);
      expect(payment.status).toBe(PaymentStatusEnum.CAPTURED);
    });

    it('is idempotent (flagging twice is a no-op, not an error)', () => {
      const payment = Payment.authorized(authorizedInput());
      payment.beginCapture();
      payment.completeCapture(new Date());

      payment.flagForRefund();
      expect(() => payment.flagForRefund()).not.toThrow();

      expect(payment.flaggedForRefund).toBe(true);
    });
  });

  describe('refund', () => {
    const capturedPayment = (amountMinor = 5997): Payment => {
      const payment = Payment.authorized({ ...authorizedInput(), amountMinor });
      payment.beginCapture();
      payment.completeCapture(new Date('2026-06-11T09:30:00Z'));
      return payment;
    };

    it('a partial refund stays captured and bumps refundedAmountMinor', () => {
      const payment = capturedPayment(5997);

      payment.refund(2000);

      expect(payment.status).toBe(PaymentStatusEnum.CAPTURED);
      expect(payment.refundedAmountMinor).toBe(2000);
    });

    it('accumulates across successive partial refunds', () => {
      const payment = capturedPayment(5997);

      payment.refund(2000);
      payment.refund(1500);

      expect(payment.status).toBe(PaymentStatusEnum.CAPTURED);
      expect(payment.refundedAmountMinor).toBe(3500);
    });

    it('a refund completing the total flips to refunded and clears the refund flag', () => {
      const payment = capturedPayment(5997);
      payment.flagForRefund();
      expect(payment.flaggedForRefund).toBe(true);

      payment.refund(5997);

      expect(payment.status).toBe(PaymentStatusEnum.REFUNDED);
      expect(payment.refundedAmountMinor).toBe(5997);
      expect(payment.flaggedForRefund).toBe(false);
    });

    it('a final partial refund that completes the total flips to refunded', () => {
      const payment = capturedPayment(5997);
      payment.refund(2000);
      payment.refund(3997);

      expect(payment.status).toBe(PaymentStatusEnum.REFUNDED);
      expect(payment.refundedAmountMinor).toBe(5997);
    });

    it('rejects a refund on a non-captured (authorized) payment', () => {
      const payment = Payment.authorized(authorizedInput());

      expect(() => payment.refund(100)).toThrow(OrderDomainException);
    });

    it('rejects an over-refund (cumulative beyond the captured amount)', () => {
      const payment = capturedPayment(5997);
      payment.refund(5000);

      expect(() => payment.refund(1000)).toThrow(Error);
      expect(payment.refundedAmountMinor).toBe(5000);
      expect(payment.status).toBe(PaymentStatusEnum.CAPTURED);
    });

    it.each([
      ['zero', 0],
      ['negative', -1],
      ['fractional', 12.5],
    ])('rejects a %s amountMinor', (_label, amountMinor) => {
      const payment = capturedPayment(5997);

      expect(() => payment.refund(amountMinor)).toThrow(Error);
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
      expect(payment.flaggedForRefund).toBe(false);
      expect(payment.refundedAmountMinor).toBe(0);
    });

    it('round-trips a flaggedForRefund payment from storage', () => {
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
        flaggedForRefund: true,
      });

      expect(payment.flaggedForRefund).toBe(true);
    });

    it('round-trips a partially refunded total from storage', () => {
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
        flaggedForRefund: true,
        refundedAmountMinor: 1000,
      });

      expect(payment.refundedAmountMinor).toBe(1000);
    });

    it.each([
      ['negative', -1],
      ['fractional', 12.5],
    ])('rejects a %s refundedAmountMinor on the load path', (_label, refundedAmountMinor) => {
      expect(() =>
        Payment.reconstitute({
          id: 9,
          orderId: 1,
          amountMinor: 5997,
          currency: 'USD',
          method: 'fake-card',
          status: PaymentStatusEnum.CAPTURED,
          gatewayReference: 'fake_abc123',
          authorizedAt: new Date('2026-06-10T00:00:00Z'),
          capturedAt: new Date('2026-06-11T09:30:00Z'),
          refundedAmountMinor,
        }),
      ).toThrow(OrderDomainException);
    });
  });
});
