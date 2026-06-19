import { RefundStatusEnum } from '@retail-inventory-system/contracts';

import { IOpenRefundInput, OrderDomainException, Refund } from '..';

const openInput = (): IOpenRefundInput => ({
  orderId: 1,
  paymentId: 7,
  amountMinor: 5997,
  currency: 'USD',
  reason: 'Customer returned the item',
});

describe('Refund', () => {
  describe('open factory', () => {
    it('opens a PENDING refund with no gateway reference and no issue stamp', () => {
      const refund = Refund.open(openInput());

      expect(refund.status).toBe(RefundStatusEnum.PENDING);
      expect(refund.gatewayReference).toBeNull();
      expect(refund.issuedAt).toBeNull();
      expect(refund.id).toBeNull();
      expect(refund.orderId).toBe(1);
      expect(refund.paymentId).toBe(7);
      expect(refund.amountMinor).toBe(5997);
      expect(refund.currency).toBe('USD');
      expect(refund.reason).toBe('Customer returned the item');
    });

    it.each([
      ['zero', 0],
      ['negative', -1],
      ['fractional', 12.5],
    ])(
      'rejects a %s amountMinor (a refund must move a strictly positive amount)',
      (_label, amountMinor) => {
        expect(() => Refund.open({ ...openInput(), amountMinor })).toThrow(OrderDomainException);
      },
    );

    it('rejects an empty reason', () => {
      expect(() => Refund.open({ ...openInput(), reason: '   ' })).toThrow(OrderDomainException);
    });

    it.each([
      ['orderId', { orderId: 0 }],
      ['paymentId', { paymentId: -3 }],
    ])('rejects a non-positive %s', (_label, override) => {
      expect(() => Refund.open({ ...openInput(), ...override })).toThrow(OrderDomainException);
    });

    it('rejects an empty currency', () => {
      expect(() => Refund.open({ ...openInput(), currency: '' })).toThrow(OrderDomainException);
    });

    // The amount ≤ Payment.amountMinor − Payment.refundedAmountMinor ceiling (the
    // over-refund guard) is NOT a model concern — the model cannot see Payment. It is
    // enforced by the Issue Refund use case (a later capability), so it is not asserted
    // here.
  });

  describe('markIssued', () => {
    it('walks pending → issued, stamping the gateway reference and issuedAt', () => {
      const refund = Refund.open(openInput());
      const at = new Date('2026-06-12T10:00:00Z');

      refund.markIssued({ gatewayReference: 'fake_refund_xyz', issuedAt: at });

      expect(refund.status).toBe(RefundStatusEnum.ISSUED);
      expect(refund.gatewayReference).toBe('fake_refund_xyz');
      expect(refund.issuedAt).toEqual(at);
    });

    it('rejects issuing a non-pending refund (a failed refund cannot be issued)', () => {
      const refund = Refund.open(openInput());
      refund.markFailed();

      expect(() =>
        refund.markIssued({ gatewayReference: 'fake_refund_xyz', issuedAt: new Date() }),
      ).toThrow(OrderDomainException);
    });

    it('rejects double-issuing', () => {
      const refund = Refund.open(openInput());
      refund.markIssued({ gatewayReference: 'fake_refund_xyz', issuedAt: new Date() });

      expect(() =>
        refund.markIssued({ gatewayReference: 'fake_refund_again', issuedAt: new Date() }),
      ).toThrow(OrderDomainException);
    });
  });

  describe('markFailed', () => {
    it('walks pending → failed', () => {
      const refund = Refund.open(openInput());

      refund.markFailed();

      expect(refund.status).toBe(RefundStatusEnum.FAILED);
      // A failed refund never stamped a gateway reference or issue moment.
      expect(refund.gatewayReference).toBeNull();
      expect(refund.issuedAt).toBeNull();
    });

    it('rejects failing a non-pending refund (an issued refund cannot fail)', () => {
      const refund = Refund.open(openInput());
      refund.markIssued({ gatewayReference: 'fake_refund_xyz', issuedAt: new Date() });

      expect(() => refund.markFailed()).toThrow(OrderDomainException);
    });
  });

  describe('reconstitute', () => {
    it('rebuilds an issued refund from storage, preserving the gateway reference + stamp', () => {
      const refund = Refund.reconstitute({
        id: 42,
        orderId: 1,
        paymentId: 7,
        amountMinor: 5997,
        currency: 'USD',
        status: RefundStatusEnum.ISSUED,
        reason: 'Customer returned the item',
        gatewayReference: 'fake_refund_xyz',
        issuedAt: new Date('2026-06-12T10:00:00Z'),
        createdAt: new Date('2026-06-12T09:59:00Z'),
        updatedAt: new Date('2026-06-12T10:00:00Z'),
      });

      expect(refund.id).toBe(42);
      expect(refund.status).toBe(RefundStatusEnum.ISSUED);
      expect(refund.gatewayReference).toBe('fake_refund_xyz');
      expect(refund.issuedAt).toEqual(new Date('2026-06-12T10:00:00Z'));
    });
  });
});
