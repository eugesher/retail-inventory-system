import { StockLocation, StockLocationTypeEnum } from '../stock-location.model';

type StockLocationProps = ConstructorParameters<typeof StockLocation>[0];

const makeProps = (overrides: Partial<StockLocationProps> = {}): StockLocationProps => ({
  id: 'default-warehouse',
  name: 'Default Warehouse',
  code: 'default-warehouse',
  type: StockLocationTypeEnum.WAREHOUSE,
  ...overrides,
});

describe('StockLocation', () => {
  describe('construction', () => {
    it('builds a location with defaults (active true, null address/gln)', () => {
      const location = new StockLocation(makeProps());

      expect(location.id).toBe('default-warehouse');
      expect(location.name).toBe('Default Warehouse');
      expect(location.code).toBe('default-warehouse');
      expect(location.type).toBe(StockLocationTypeEnum.WAREHOUSE);
      expect(location.address).toBeNull();
      expect(location.gln).toBeNull();
      expect(location.active).toBe(true);
    });

    it.each(['id', 'name', 'code'] as const)('rejects an empty %s', (field) => {
      expect(() => new StockLocation(makeProps({ [field]: '   ' }))).toThrow(field);
    });

    it('accepts a valid 13-digit gln', () => {
      const location = new StockLocation(makeProps({ gln: '0614141000037' }));
      expect(location.gln).toBe('0614141000037');
    });

    it.each(['123', '06141410000370', 'abcdefghijklm'])('rejects a malformed gln %s', (gln) => {
      expect(() => new StockLocation(makeProps({ gln }))).toThrow('gln');
    });

    it('preserves a provided address payload', () => {
      const address = { city: 'Berlin', country: 'DE' };
      const location = new StockLocation(makeProps({ address }));
      expect(location.address).toEqual(address);
    });
  });

  describe('deactivate', () => {
    it('flips active to false (soft-delete via the flag, never deletedAt)', () => {
      const location = new StockLocation(makeProps({ active: true }));
      location.deactivate();
      expect(location.active).toBe(false);
    });
  });

  describe('StockLocationTypeEnum', () => {
    it('exposes the three location kinds with their wire values', () => {
      expect(StockLocationTypeEnum.WAREHOUSE).toBe('warehouse');
      expect(StockLocationTypeEnum.STORE).toBe('store');
      expect(StockLocationTypeEnum.DROPSHIP_VIRTUAL).toBe('dropship-virtual');
    });
  });
});
