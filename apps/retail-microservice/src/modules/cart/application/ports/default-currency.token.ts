// DI token for the currency a cart opens in when the caller names none. A
// `ConfigService`-backed value provider in `cart.module.ts` resolves it from
// `DEFAULT_CURRENCY` (Joi: 3 chars, uppercased, default `USD`), so `CreateCartUseCase`
// injects a plain `string` and never reads env — the catalog
// `CATALOG_DEFAULT_CURRENCY ← DEFAULT_CURRENCY` precedent. It is a provider token, not a
// port, but lives next to the ports so the use-case wiring stays greppable in one place
// (the inventory `RESERVATION_TTL_MINUTES` precedent).
//
// **It reads the SAME env var as catalog, and that is the point.** Before this token the
// cart resolved the default from a file-local `const DEFAULT_CURRENCY = 'USD'`, so
// setting `DEFAULT_CURRENCY=EUR` made catalog quote EUR while every new cart still opened
// in USD. `Cart.currency` is immutable (ADR-028 §1) and the order snapshots it at
// place-time, so the wrong unit was baked into the order and the payment with nothing
// downstream able to tell — the amounts were right, the CURRENCY was wrong. Two contexts
// answering "what currency, if the caller didn't say?" must answer from one variable.
//
// The token is named after the CONSUMING module (`RETAIL_…`, not `CART_…`) so a second
// retail module that needs the same default binds to this one rather than minting a
// rival literal.
export const RETAIL_DEFAULT_CURRENCY = Symbol('RETAIL_DEFAULT_CURRENCY');
