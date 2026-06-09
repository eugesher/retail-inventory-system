import { Order } from '../../domain';

export const ORDER_REPOSITORY = Symbol('ORDER_REPOSITORY');

// Pagination shapes for the order read path, declared **locally** rather than
// imported from `libs/common`. The boundaries lint keeps the application-port layer
// to domain + ddd + contracts only (ADR-017) — the port is a pure TypeScript
// contract with no framework or cross-lib utility imports. This mirrors the catalog
// port's `IProductPage` / inline-query precedent.
export interface IOrderPageRequest {
  page: number;
  size: number;
}

export interface IOrderPage {
  items: Order[];
  total: number;
  page: number;
  size: number;
}

// The repository seam for the order write/read paths. It returns domain types only
// — no TypeORM entity, `Repository`, or `EntityManager` type leaks here (ADR-017
// forbids `typeorm` in `application/ports`). The TypeORM details live entirely in
// `OrderTypeormRepository`.
//
// The order operations + their gateway land in later capabilities; this foundation
// only fixes the contract:
// - `save` upserts the root together with its lines and re-reads the saved graph
//   so the generated BIGINT id + `order_line.id`s come back concrete, and finalizes
//   the human-facing `order_number` from the generated id on first insert (the
//   "re-read the saved graph, then finalize a derived field" idiom).
// - `findBySourceCartId` backs repeat-place idempotency — re-placing a cart that
//   already converted returns the order it converted into rather than a second one.
// - `listByCustomer` backs the customer's order history (owner-checked at the use
//   case, ADR-028 §7).
// - `nextOrderNumber` formats the next human-facing number; the binding value is
//   finalized inside `save` from the order's real id, so the two always agree.
export interface IOrderRepositoryPort {
  findById(id: number): Promise<Order | null>;
  findBySourceCartId(cartId: string): Promise<Order | null>;
  save(order: Order): Promise<Order>;
  listByCustomer(customerId: string, page: IOrderPageRequest): Promise<IOrderPage>;
  nextOrderNumber(): Promise<string>;
}
