import { Storage } from '../storage.model';

describe('Storage', () => {
  it('exposes the id via the getter', () => {
    const storage = new Storage('head-warehouse');
    expect(storage.id).toBe('head-warehouse');
  });

  it('rejects empty strings', () => {
    expect(() => new Storage('')).toThrow(/id must be a non-empty string/);
    expect(() => new Storage('   ')).toThrow(/id must be a non-empty string/);
  });

  it('compares equal by structural value', () => {
    const a = new Storage('head-warehouse');
    const b = new Storage('head-warehouse');
    expect(a.equals(b)).toBe(true);
  });

  it('compares unequal when the id differs', () => {
    const a = new Storage('head-warehouse');
    const b = new Storage('east-warehouse');
    expect(a.equals(b)).toBe(false);
  });
});
