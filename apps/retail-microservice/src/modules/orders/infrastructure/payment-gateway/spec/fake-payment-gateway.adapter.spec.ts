import { FakePaymentGatewayAdapter } from '../fake-payment-gateway.adapter';

// Adapter **contract conformance**: these assertions pin the `IPaymentGatewayPort`
// shape the fake must satisfy, so a real adapter later can be held to the same bar.
describe('FakePaymentGatewayAdapter', () => {
  let adapter: FakePaymentGatewayAdapter;

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
});
