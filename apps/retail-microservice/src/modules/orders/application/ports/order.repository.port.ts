import { Order } from '../../domain';
import { ITransactionScope } from './transaction.port';

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
// The contract the place + read/capture operations depend on:
// - `save` upserts the root together with its lines and re-reads the saved graph
//   so the generated BIGINT id + `order_line.id`s come back concrete, and finalizes
//   the human-facing `order_number` from the generated id on first insert (the
//   "re-read the saved graph, then finalize a derived field" idiom). It accepts an
//   optional `scope` so Place Order's order + address + cart-conversion writes share
//   one transaction (ADR-017 §6); without a scope it opens its own transaction. It
//   also accepts an optional `expectedVersion`: when supplied (a status transition on
//   an existing order — capture / ship / deliver / cancel) the root write is an
//   optimistic compare-and-swap on `version` (`UPDATE … WHERE id = ? AND version = ?`,
//   ADR-036) — a zero-rows result throws the internal `OrderWriteConflictError` the
//   retry helper catches; absent (the place insert, or the inline authorize-on-place
//   write on a brand-new order with no concurrent writer) the root persists via the
//   plain managed save that still advances `@VersionColumn`.
// - `attachAddresses` finalizes the two snapshot-address FK columns from a
//   targeted UPDATE once both `address` rows exist (the same "finalize a derived
//   column after the row is written" idiom `order_number` uses) — the order is
//   inserted with NULL address ids, the addresses are written owning the order id,
//   then the order's `billing/shipping_address_id` are patched, all in one
//   transaction (ADR-028 §5).
// - `findById` is the by-id load path (optionally scoped, so the authorize follow-up
//   transaction reads the just-placed order within its own unit of work).
// - `findBySourceCartId` backs repeat-place idempotency — re-placing a cart that
//   already converted returns the order it converted into rather than a second one.
// - `listByCustomer` backs the customer's order history (owner-checked at the use
//   case, ADR-028 §7).
export interface IOrderRepositoryPort {
  findById(id: number, scope?: ITransactionScope): Promise<Order | null>;
  findBySourceCartId(cartId: string): Promise<Order | null>;
  save(order: Order, scope?: ITransactionScope, expectedVersion?: number): Promise<Order>;
  attachAddresses(
    orderId: number,
    billingAddressId: string,
    shippingAddressId: string,
    scope?: ITransactionScope,
  ): Promise<void>;
  listByCustomer(customerId: string, page: IOrderPageRequest): Promise<IOrderPage>;
}
