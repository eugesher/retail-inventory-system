export class CacheHelper {
  public static ttlValues = {
    productStock: 60_000,
  };

  public static keyPrefixes = {
    productStock: (productId: number): string => `stock:${productId}:`,
  };

  public static keys = {
    productStock: (productId: number, storageIds?: string[]): string => {
      const prefix = CacheHelper.keyPrefixes.productStock(productId);
      const storageKey = storageIds
        ? [...storageIds].sort((a, b) => a.charCodeAt(0) - b.charCodeAt(0)).join(',')
        : '*';

      return `${prefix}${storageKey}`;
    },
  };
}
