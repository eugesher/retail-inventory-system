import { IPaymentGatewayPort } from '../../../application/ports';
import { FakePaymentGatewayAdapter } from '../fake-payment-gateway.adapter';

// Adapter **contract conformance**: these assertions pin the `IPaymentGatewayPort`
// shape the fake must satisfy, so a real adapter later can be held to the same bar. The
// adapter is held through the port type so the calls exercise the contract signatures
// (e.g. `refund(req)`) rather than the fake's narrowed implementation arity.
describe('FakePaymentGatewayAdapter', () => {
  let adapter: IPaymentGatewayPort;

  beforeEach(() => {
    adapter = new FakePaymentGatewayAdapter();
  });

  describe('authorize', () => {
    it('always approves with a non-empty gatewayReference + method and an authorizedAt Date', async () => {
      const result = await adapter.authorize({
        orderId: 1,
        amountMinor: 5997,
        currency: 'USD',
      });

      expect(result.approved).toBe(true);
      expect(typeof result.gatewayReference).toBe('string');
      expect(result.gatewayReference.length).toBeGreaterThan(0);
      expect(result.gatewayReference.startsWith('fake_')).toBe(true);
      expect(typeof result.method).toBe('string');
      expect(result.method.length).toBeGreaterThan(0);
      expect(result.authorizedAt).toBeInstanceOf(Date);
    });

    it('echoes the caller method when supplied, else defaults to fake-card', async () => {
      const echoed = await adapter.authorize({
        orderId: 1,
        amountMinor: 100,
        currency: 'USD',
        method: 'tok_visa',
      });
      expect(echoed.method).toBe('tok_visa');

      const defaulted = await adapter.authorize({ orderId: 1, amountMinor: 100, currency: 'USD' });
      expect(defaulted.method).toBe('fake-card');
    });

    it('mints a distinct gatewayReference per call (the unique column relies on it)', async () => {
      const first = await adapter.authorize({ orderId: 1, amountMinor: 100, currency: 'USD' });
      const second = await adapter.authorize({ orderId: 1, amountMinor: 100, currency: 'USD' });

      expect(first.gatewayReference).not.toBe(second.gatewayReference);
    });
  });

  describe('capture', () => {
    it('always captures, echoing the reference, with a capturedAt Date', async () => {
      const { gatewayReference } = await adapter.authorize({
        orderId: 1,
        amountMinor: 100,
        currency: 'USD',
      });

      const result = await adapter.capture(gatewayReference);

      expect(result.captured).toBe(true);
      expect(result.gatewayReference).toBe(gatewayReference);
      expect(result.capturedAt).toBeInstanceOf(Date);
    });
  });

  describe('refund', () => {
    it('always refunds with a fresh fake_refund_ reference and a refundedAt Date', async () => {
      const { gatewayReference } = await adapter.authorize({
        orderId: 1,
        amountMinor: 100,
        currency: 'USD',
      });

      const result = await adapter.refund({
        gatewayReference,
        amountMinor: 100,
        currency: 'USD',
      });

      expect(result.refunded).toBe(true);
      expect(typeof result.gatewayReference).toBe('string');
      // The refund reference is fresh — distinct from the charge reference it reverses.
      expect(result.gatewayReference.startsWith('fake_refund_')).toBe(true);
      expect(result.gatewayReference).not.toBe(gatewayReference);
      expect(result.refundedAt).toBeInstanceOf(Date);
    });

    it('mints a distinct refund reference per call', async () => {
      const first = await adapter.refund({
        gatewayReference: 'fake_charge',
        amountMinor: 100,
        currency: 'USD',
      });
      const second = await adapter.refund({
        gatewayReference: 'fake_charge',
        amountMinor: 100,
        currency: 'USD',
      });

      expect(first.gatewayReference).not.toBe(second.gatewayReference);
    });
  });
});
