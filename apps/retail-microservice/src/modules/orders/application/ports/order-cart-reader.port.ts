import { ITransactionScope } from './transaction.port';

export const ORDER_CART_READER = Symbol('ORDER_CART_READER');

// A flat read projection of a cart, just enough for Place Order: the owner-check
// (`customerId`), the snapshot currency, the placeability guard (`status`), and the
// lines to snapshot (`variantId` + `quantity`). It is deliberately NOT the cart
// domain aggregate — the orders module cannot import the cart module's `Cart` /
// `ICartRepositoryPort` (the boundaries lint forbids the cross-module import,
// ADR-017). The cart is a sibling module behind a hard isolation line.
export interface IOrderCartSnapshot {
  cartId: string;
  customerId: string | null;
  currency: string;
  status: string; // 'active' | 'abandoned' | 'converted'
  lines: { variantId: number; quantity: number }[];
}

// The orders context's seam onto the cart tables — the **only** way Place Order
// reaches the cart. Its adapter reads/writes `cart` / `cart_line` with parameterized
// SQL through the injected `EntityManager`, never importing the cart module's
// entities (the exact cross-module precedent pricing uses for the catalog-owned
// `product_variant.tax_category_id` — ADR-017 / ADR-026 §5). The opaque shared FK
// (`cart.id`) is the only coupling.
//
// - `findCart` resolves the snapshot (read-only, outside any transaction).
// - `markConverted` flips an `active` cart to `converted` inside the place
//   transaction (the `scope`), the one-shot conversion (ADR-028 §1). The
//   `WHERE status = 'active'` guard makes a double-convert a no-op. Domain types
//   only — no `typeorm` leak (ADR-017).
export interface IOrderCartReaderPort {
  findCart(cartId: string): Promise<IOrderCartSnapshot | null>;
  markConverted(cartId: string, scope?: ITransactionScope): Promise<void>;
}
