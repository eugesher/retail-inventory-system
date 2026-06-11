import { CartView, IAddressInput, OrderView } from '@retail-inventory-system/contracts';

export const CART_GATEWAY_PORT = Symbol('CART_GATEWAY_PORT');

// Business-shaped command/query inputs for the gateway cart port. They omit
// `correlationId` — a transport concern threaded separately and stitched onto the
// wire payload inside the adapter (the catalog/inventory gateway split).
//
// `customerId` is the resolved caller — the controller folds in `@CurrentUser().id`
// from the verified bearer token, so a customer can only ever act as itself. The
// retail use cases enforce `cart.customerId === customerId` and answer 403 on a
// mismatch (the owner-check), so the identity binding here is the gateway half of
// the bearer-plus-owner-check model (ADR-028 §7 / ADR-024 — no customer
// permission code).
export interface ICartCreateCommand {
  customerId: string;
  currency?: string;
}

export interface ICartGetQuery {
  cartId: string;
  customerId: string;
}

export interface ICartAddLineCommand {
  cartId: string;
  customerId: string;
  variantId: number;
  quantity: number;
}

export interface ICartChangeLineQuantityCommand {
  cartId: string;
  customerId: string;
  lineId: number;
  quantity: number;
}

export interface ICartRemoveLineCommand {
  cartId: string;
  customerId: string;
  lineId: number;
}

// Claim carries the guest-ownership proof (`fromCustomerId`, the guest id the
// client received from the guest-session response) and the registered customer
// (`newCustomerId`, folded from `@CurrentUser().id`).
export interface ICartClaimCommand {
  cartId: string;
  fromCustomerId: string;
  newCustomerId: string;
}

// Place Order carries the two snapshot address bundles + the optional opaque
// payment method, plus the `idempotencyKey` read from the `Idempotency-Key` header
// (accepted + forwarded, NOT deduped — Q10). `customerId` is the folded
// `@CurrentUser().id`; the retail use case re-asserts `cart.customerId ===
// customerId` (the owner-check).
export interface ICartPlaceCommand {
  cartId: string;
  customerId: string;
  shippingAddress: IAddressInput;
  billingAddress: IAddressInput;
  paymentMethod?: string;
  idempotencyKey?: string;
}

// The gateway-side seam onto the retail microservice's six cart RPCs. The
// concrete implementation (`CartRabbitmqAdapter`) is the only holder of a
// `ClientProxy`; use cases and the controller depend on this interface (ADR-009).
// Every method resolves to the retail `CartView`, surfaced over HTTP unchanged.
export interface ICartGatewayPort {
  createCart(command: ICartCreateCommand, correlationId: string): Promise<CartView>;
  getCart(query: ICartGetQuery, correlationId: string): Promise<CartView>;
  addLine(command: ICartAddLineCommand, correlationId: string): Promise<CartView>;
  changeLineQuantity(
    command: ICartChangeLineQuantityCommand,
    correlationId: string,
  ): Promise<CartView>;
  removeLine(command: ICartRemoveLineCommand, correlationId: string): Promise<CartView>;
  claim(command: ICartClaimCommand, correlationId: string): Promise<CartView>;
  // Place resolves to the retail `OrderView` (the placed order + its lines + the
  // authorized payment), surfaced over HTTP unchanged.
  placeOrder(command: ICartPlaceCommand, correlationId: string): Promise<OrderView>;
}
