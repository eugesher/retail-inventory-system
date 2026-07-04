import { ConsentRecord } from '../consent-record.model';

const CUSTOMER_ID = 'cccccccc-cccc-4ccc-accc-cccccccccccc';

describe('ConsentRecord', () => {
  describe('default', () => {
    it('yields transactional-on, marketing-off, seven-year retention, no updatedAt', () => {
      const record = ConsentRecord.default(CUSTOMER_ID);

      expect(record.customerId).toBe(CUSTOMER_ID);
      expect(record.transactionalEmail).toBe(true);
      expect(record.marketingEmail).toBe(false);
      expect(record.marketingSms).toBe(false);
      expect(record.dataRetentionPolicy).toBe('default-7-years');
      expect(record.updatedAt).toBeNull();
    });
  });

  describe('construction invariants', () => {
    it('throws when customerId is empty', () => {
      expect(() => ConsentRecord.default('')).toThrow(/customerId is required/);
    });

    it('throws when customerId is whitespace-only', () => {
      expect(() => ConsentRecord.default('   ')).toThrow(/customerId is required/);
    });
  });

  describe('rehydrate', () => {
    it('loads stored props verbatim, including a populated updatedAt', () => {
      const updatedAt = new Date('2026-07-01T12:00:00.000Z');
      const record = ConsentRecord.rehydrate(CUSTOMER_ID, {
        transactionalEmail: false,
        marketingEmail: true,
        marketingSms: true,
        dataRetentionPolicy: 'gdpr-minimal',
        updatedAt,
      });

      expect(record.transactionalEmail).toBe(false);
      expect(record.marketingEmail).toBe(true);
      expect(record.marketingSms).toBe(true);
      expect(record.dataRetentionPolicy).toBe('gdpr-minimal');
      expect(record.updatedAt).toEqual(updatedAt);
    });
  });

  describe('apply', () => {
    it('overlays only the supplied key, leaving the rest untouched', () => {
      const record = ConsentRecord.default(CUSTOMER_ID);

      record.apply({ marketingEmail: true });

      expect(record.marketingEmail).toBe(true);
      // The other three defaults are untouched.
      expect(record.transactionalEmail).toBe(true);
      expect(record.marketingSms).toBe(false);
      expect(record.dataRetentionPolicy).toBe('default-7-years');
    });

    it('can flip a flag back to false explicitly', () => {
      const record = ConsentRecord.default(CUSTOMER_ID);

      record.apply({ transactionalEmail: false });

      expect(record.transactionalEmail).toBe(false);
    });

    it('overlays several keys at once and returns the same instance', () => {
      const record = ConsentRecord.default(CUSTOMER_ID);

      const returned = record.apply({
        marketingEmail: true,
        marketingSms: true,
        dataRetentionPolicy: 'gdpr-minimal',
      });

      expect(returned).toBe(record);
      expect(record.marketingEmail).toBe(true);
      expect(record.marketingSms).toBe(true);
      expect(record.dataRetentionPolicy).toBe('gdpr-minimal');
    });

    it('is a no-op for an empty overlay', () => {
      const record = ConsentRecord.default(CUSTOMER_ID);

      record.apply({});

      expect(record.transactionalEmail).toBe(true);
      expect(record.marketingEmail).toBe(false);
      expect(record.marketingSms).toBe(false);
    });
  });

  describe('toView', () => {
    it('serializes updatedAt to an ISO string', () => {
      const updatedAt = new Date('2026-07-01T12:00:00.000Z');
      const record = ConsentRecord.rehydrate(CUSTOMER_ID, {
        transactionalEmail: true,
        marketingEmail: false,
        marketingSms: false,
        dataRetentionPolicy: 'default-7-years',
        updatedAt,
      });

      expect(record.toView()).toEqual({
        customerId: CUSTOMER_ID,
        transactionalEmail: true,
        marketingEmail: false,
        marketingSms: false,
        dataRetentionPolicy: 'default-7-years',
        updatedAt: '2026-07-01T12:00:00.000Z',
      });
    });

    it('emits a null updatedAt for a default (unwritten) record', () => {
      expect(ConsentRecord.default(CUSTOMER_ID).toView().updatedAt).toBeNull();
    });
  });
});
