import { ROUTING_KEYS } from '../routing-keys.constants';

describe('ROUTING_KEYS', () => {
  const entries = Object.entries(ROUTING_KEYS);

  it('is a non-empty registry', () => {
    expect(entries.length).toBeGreaterThan(50);
  });

  it('derives every constant name from its wire value', () => {
    for (const [name, value] of entries) {
      expect(name).toBe(value.replace(/[.-]/g, '_').toUpperCase());
    }
  });

  it('uses the dotted lower-case wire convention', () => {
    for (const [, value] of entries) {
      expect(value).toMatch(/^[a-z]+(\.[a-z-]+)+$/);
    }
  });

  it('maps no two names onto the same wire key', () => {
    const values = entries.map(([, value]) => value);
    expect(new Set(values).size).toBe(values.length);
  });
});
