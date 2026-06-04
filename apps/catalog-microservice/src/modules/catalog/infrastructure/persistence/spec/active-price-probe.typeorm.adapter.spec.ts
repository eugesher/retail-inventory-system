import { EntityManager, Repository } from 'typeorm';

import { ActivePriceProbeTypeormAdapter } from '../active-price-probe.typeorm.adapter';
import { ProductVariantEntity } from '../product-variant.entity';

// The probe reads the pricing-owned `price` table through the catalog variant
// repository's shared manager — a PARAMETERIZED query, no pricing import
// (ADR-017). These specs assert the SQL is parameterized (placeholders + a bound
// args array, never string interpolation of the ids), the mysql2 string-BIGINT
// coercion holds, and the requested ids are correctly diffed against the priced
// set.
describe('ActivePriceProbeTypeormAdapter', () => {
  let variantRepo: jest.Mocked<{ manager: Pick<EntityManager, 'query'> }>;
  let adapter: ActivePriceProbeTypeormAdapter;

  beforeEach(() => {
    jest.resetAllMocks();
    variantRepo = { manager: { query: jest.fn() } } as never;
    adapter = new ActivePriceProbeTypeormAdapter(
      variantRepo as unknown as Repository<ProductVariantEntity>,
    );
  });

  it('short-circuits to [] without querying when there are no variant ids', async () => {
    const query = variantRepo.manager.query as unknown as jest.Mock;

    await expect(adapter.findVariantsMissingActivePrice([], 'USD')).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('reads the price table with a parameterized query and reports the unpriced variants', async () => {
    const query = variantRepo.manager.query as unknown as jest.Mock;
    // Variant 5001 has an in-effect price; 5002 does not.
    query.mockResolvedValue([{ variantId: 5001 }]);

    const missing = await adapter.findVariantsMissingActivePrice([5001, 5002], 'USD');

    expect(missing).toEqual([5002]);
    // One `?` per id plus the currency — every value is driver-bound, never
    // string-interpolated into the SQL.
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM price'), [5001, 5002, 'USD']);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('variant_id IN (?, ?)'), [
      5001,
      5002,
      'USD',
    ]);
  });

  it('coerces string BIGINT variant_id values (mysql2) before diffing', async () => {
    const query = variantRepo.manager.query as unknown as jest.Mock;
    // mysql2 may surface the non-PK BIGINT as a string; the coercion must still
    // match the numeric requested id.
    query.mockResolvedValue([{ variantId: '5001' }]);

    await expect(adapter.findVariantsMissingActivePrice([5001, 5002], 'USD')).resolves.toEqual([
      5002,
    ]);
  });

  it('reports every variant missing when none are priced', async () => {
    const query = variantRepo.manager.query as unknown as jest.Mock;
    query.mockResolvedValue([]);

    const missing = await adapter.findVariantsMissingActivePrice([5001, 5002], 'EUR');

    expect(missing).toEqual([5001, 5002]);
    expect(query).toHaveBeenCalledWith(expect.any(String), [5001, 5002, 'EUR']);
  });

  it('reports nothing missing when every variant is priced', async () => {
    const query = variantRepo.manager.query as unknown as jest.Mock;
    query.mockResolvedValue([{ variantId: 5001 }, { variantId: 5002 }]);

    await expect(adapter.findVariantsMissingActivePrice([5001, 5002], 'USD')).resolves.toEqual([]);
  });
});
