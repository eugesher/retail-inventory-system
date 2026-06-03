// Wire-format paginated envelope for the catalog read path (e.g. the
// `catalog.product.list` response is an `IPage<ProductWithVariantsView>`).
//
// The canonical pagination types `IPage<T>` / `IPageRequest` live in
// `@retail-inventory-system/common` (ADR-005). They are deliberately *not*
// imported here: the architecture boundaries (ADR-017) keep `lib-contracts`
// importing only `lib-contracts`, and the gateway-facing `presentation` layer
// that names this response type can reach `lib-contracts` but not `lib-common`.
// So the wire contract re-declares the identical `{ items, total, page, size }`
// shape where both the read use case and the RMQ controller can reach it — the
// same local-declaration pattern the catalog repository port uses for its
// internal `IProductPage`. `page` is 1-based; `size` is the page size actually
// applied.
export interface IPage<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}
