export const ACTIVE_PRICE_PROBE = Symbol('ACTIVE_PRICE_PROBE');

export interface IActivePriceProbePort {
  findVariantsMissingActivePrice(variantIds: number[], currency: string): Promise<number[]>;
}

export const CATALOG_DEFAULT_CURRENCY = Symbol('CATALOG_DEFAULT_CURRENCY');
