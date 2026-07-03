import { Cart } from '../../domain';

export const CART_REPOSITORY = Symbol('CART_REPOSITORY');

// The repository seam for the cart write/read paths. It returns domain types only
// — no TypeORM entity, `Repository`, or `EntityManager` type leaks here (ADR-017
// forbids `typeorm` in `application/ports`). The TypeORM details live entirely in
// `CartTypeormRepository`.
//
// `save` upserts the root together with its lines and re-reads the saved graph so
// generated `cart_line.id`s come back concrete (the "re-read the saved graph"
// idiom `CatalogTypeormRepository` uses). `reassignCustomer` is the
// guest-promotion seam (an authenticated shopper claims a guest cart).
//
// `expectedVersion` is the optimistic-concurrency anchor (ADR-036): pass the cart
// root's version **as read** (captured before the in-memory mutation) and the save
// performs a version-checked compare-and-swap on the root — `UPDATE … SET version =
// version + 1 WHERE id = ? AND version = expectedVersion`. Zero rows affected means
// a concurrent writer advanced the row first, so the save throws
// `CartWriteConflictError` (which `runWithCartWriteRetry` retries or maps to
// `409 VERSION_MISMATCH`). Omit it on the create path (a brand-new cart has no
// live row to race), where the save falls back to a plain insert.
export interface ICartRepositoryPort {
  findById(id: string): Promise<Cart | null>;
  save(cart: Cart, expectedVersion?: number): Promise<Cart>;
  reassignCustomer(cartId: string, customerId: string): Promise<void>;
}
