import { Cart } from '../../domain';

export const CART_REPOSITORY = Symbol('CART_REPOSITORY');

// The repository seam for the cart write/read paths. It returns domain types only
// — no TypeORM entity, `Repository`, or `EntityManager` type leaks here (ADR-017
// forbids `typeorm` in `application/ports`). The TypeORM details live entirely in
// `CartTypeormRepository`.
//
// The cart operations + their gateway land in a later capability; this foundation
// only fixes the contract. `save` upserts the root together with its lines and
// re-reads the saved graph so generated `cart_line.id`s come back concrete (the
// "re-read the saved graph" idiom `CatalogTypeormRepository` uses).
// `reassignCustomer` is the guest-promotion seam (an authenticated shopper claims
// a guest cart) — its use case arrives with the cart operations.
export interface ICartRepositoryPort {
  findById(id: string): Promise<Cart | null>;
  save(cart: Cart): Promise<Cart>;
  reassignCustomer(cartId: string, customerId: string): Promise<void>;
}
