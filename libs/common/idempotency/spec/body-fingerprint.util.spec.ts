import { bodyFingerprint } from '../body-fingerprint.util';

// Locks the request-body fingerprint contract that the idempotency store relies
// on to tell a safe replay (same key + same body) from key-reuse (same key +
// different body → 422). The digest MUST be a pure function of the *logical*
// content: independent of object key order, sensitive to every value / type /
// structure change, and stable enough to persist in a CHAR(64) column.
describe('bodyFingerprint', () => {
  describe('determinism across key order (the replay guarantee)', () => {
    it('produces the same digest regardless of top-level key order', () => {
      expect(bodyFingerprint({ a: 1, b: 2 })).toBe(bodyFingerprint({ b: 2, a: 1 }));
    });

    it('sorts keys recursively — nested objects are order-invariant too', () => {
      const first = { outer: { a: 1, b: { x: 1, y: 2 } }, z: 3 };
      const second = { z: 3, outer: { b: { y: 2, x: 1 }, a: 1 } };
      expect(bodyFingerprint(first)).toBe(bodyFingerprint(second));
    });

    it('sorts keys of objects nested inside arrays', () => {
      const first = { lines: [{ variantId: 'v1', qty: 2 }] };
      const second = { lines: [{ qty: 2, variantId: 'v1' }] };
      expect(bodyFingerprint(first)).toBe(bodyFingerprint(second));
    });

    it('is idempotent — the same input hashes identically across two calls', () => {
      const body = { a: 1, b: [1, 2, 3], c: { d: true } };
      expect(bodyFingerprint(body)).toBe(bodyFingerprint(body));
    });
  });

  describe('sensitivity to values and structure', () => {
    it('changes when a value changes', () => {
      expect(bodyFingerprint({ a: 1 })).not.toBe(bodyFingerprint({ a: 2 }));
    });

    it('distinguishes a type change (1 vs "1")', () => {
      expect(bodyFingerprint({ a: 1 })).not.toBe(bodyFingerprint({ a: '1' }));
    });

    it('distinguishes number from boolean and boolean from string', () => {
      expect(bodyFingerprint({ a: 1 })).not.toBe(bodyFingerprint({ a: true }));
      expect(bodyFingerprint({ a: true })).not.toBe(bodyFingerprint({ a: 'true' }));
    });

    it('changes when a key is added', () => {
      expect(bodyFingerprint({ a: 1 })).not.toBe(bodyFingerprint({ a: 1, b: 2 }));
    });

    it('changes when a key is removed', () => {
      expect(bodyFingerprint({ a: 1, b: 2 })).not.toBe(bodyFingerprint({ a: 1 }));
    });

    it('is array-order-sensitive — a reordered list is a different body', () => {
      expect(bodyFingerprint([1, 2, 3])).not.toBe(bodyFingerprint([3, 2, 1]));
    });

    it('is array-order-sensitive for arrays of objects (reordered cart lines)', () => {
      const a = { lines: [{ variantId: 'v1' }, { variantId: 'v2' }] };
      const b = { lines: [{ variantId: 'v2' }, { variantId: 'v1' }] };
      expect(bodyFingerprint(a)).not.toBe(bodyFingerprint(b));
    });

    it('distinguishes a nested value change at depth', () => {
      const a = { outer: { inner: { qty: 1 } } };
      const b = { outer: { inner: { qty: 2 } } };
      expect(bodyFingerprint(a)).not.toBe(bodyFingerprint(b));
    });
  });

  describe('undefined vs absent vs null policy', () => {
    it('drops an undefined-valued key — indistinguishable from an absent key', () => {
      expect(bodyFingerprint({ a: 1, b: undefined })).toBe(bodyFingerprint({ a: 1 }));
    });

    it('retains null and keeps it distinct from an absent key', () => {
      expect(bodyFingerprint({ a: 1, b: null })).not.toBe(bodyFingerprint({ a: 1 }));
    });

    it('keeps null distinct from an undefined-valued key', () => {
      expect(bodyFingerprint({ a: 1, b: null })).not.toBe(bodyFingerprint({ a: 1, b: undefined }));
    });
  });

  describe('output shape', () => {
    it('is a lowercase 64-character hex string (fits CHAR(64))', () => {
      expect(bodyFingerprint({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
    });

    it('emits a well-defined digest even for edge inputs', () => {
      // Top-level undefined/null both canonicalize to a stable string, so the
      // helper never throws and always returns a 64-hex digest.
      expect(bodyFingerprint(undefined)).toMatch(/^[0-9a-f]{64}$/);
      expect(bodyFingerprint(null)).toMatch(/^[0-9a-f]{64}$/);
      expect(bodyFingerprint({})).toMatch(/^[0-9a-f]{64}$/);
      expect(bodyFingerprint([])).toMatch(/^[0-9a-f]{64}$/);
    });

    it('matches the known SHA-256 digest of the canonical form', () => {
      // Canonical form of { b: 2, a: 1 } is '{"a":1,"b":2}'; this pins the exact
      // wire bytes so a change to the canonicalization is caught, not just its
      // self-consistency.
      const knownDigest = '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777';
      expect(bodyFingerprint({ b: 2, a: 1 })).toBe(knownDigest);
    });
  });

  describe('a representative place-order-shaped payload', () => {
    const placeOrder = {
      customerId: 'c-123',
      shippingAddress: {
        line1: '1 Market St',
        city: 'Springfield',
        postalCode: '00001',
        country: 'US',
      },
      lines: [
        { variantId: 'v-1', quantity: 2 },
        { variantId: 'v-2', quantity: 1 },
      ],
    };

    it('digests stably across two calls', () => {
      expect(bodyFingerprint(placeOrder)).toBe(bodyFingerprint(placeOrder));
    });

    it('digests the same value regardless of how the object was assembled', () => {
      // Same logical body, keys assembled in a different order at every level.
      const reordered = {
        lines: [
          { quantity: 2, variantId: 'v-1' },
          { quantity: 1, variantId: 'v-2' },
        ],
        shippingAddress: {
          country: 'US',
          postalCode: '00001',
          city: 'Springfield',
          line1: '1 Market St',
        },
        customerId: 'c-123',
      };
      expect(bodyFingerprint(reordered)).toBe(bodyFingerprint(placeOrder));
    });

    it('changes when a line quantity changes', () => {
      const bumped = {
        ...placeOrder,
        lines: [
          { variantId: 'v-1', quantity: 3 },
          { variantId: 'v-2', quantity: 1 },
        ],
      };
      expect(bodyFingerprint(bumped)).not.toBe(bodyFingerprint(placeOrder));
    });
  });
});
