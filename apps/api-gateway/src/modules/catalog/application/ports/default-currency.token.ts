// DI token for the currency the price-read endpoints scope to when the caller names none. A
// `ConfigService`-backed value provider in the gateway's `catalog.module.ts` resolves it from
// `DEFAULT_CURRENCY` — the **same** variable the catalog microservice prices against
// (`CATALOG_DEFAULT_CURRENCY`) and the cart opens in (`RETAIL_DEFAULT_CURRENCY`). The use case injects
// a plain `string` and never reads env.
//
// **This is the third and last reader of `DEFAULT_CURRENCY`, and it was the loudest gap** (ISSUE-11).
// `PriceQueryDto` carried `public currency = 'USD'` — a field initializer the global `ValidationPipe`
// keeps, so an omitted `?currency=` put `USD` on the wire for the caller. On a shop configured
// `DEFAULT_CURRENCY=EUR` the catalog holds only EUR prices (`PublishProductUseCase` will not publish a
// variant without an active price in `CATALOG_DEFAULT_CURRENCY`), so both `@Public()` price reads asked
// for a currency the catalog does not stock and **found nothing, for every variant** — a correctly
// configured shop that cannot display a price.
//
// **The default stays a GATEWAY concern, and that is deliberate.** `IPriceQuery.currency` is required
// on the wire and its comment says why: *"defaulting it is a gateway-DTO concern, not a contract
// one."* That decision was right and is kept. The bug was never *where* the default lived — it was
// that the gateway resolved it from a **literal** instead of from the configuration. So nothing in
// `libs/contracts/` or `modules/pricing/` changes; the default simply moves from a DTO initializer to
// a config read, one layer in.
//
// Named after the **consuming** module (the gateway's `catalog`), per the convention — it cannot reuse
// the microservice's `CATALOG_DEFAULT_CURRENCY`, which lives in a different deployable.
export const CATALOG_GATEWAY_DEFAULT_CURRENCY = Symbol('CATALOG_GATEWAY_DEFAULT_CURRENCY');
