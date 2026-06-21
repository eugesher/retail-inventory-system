# The template renderer: Handlebars behind a port

This document explains the **template renderer** — the component that turns a stored
template's subject/body source into the final string a notification carries. It covers why
Handlebars was chosen, why the engine import is confined to one adapter behind a port, the
security posture that governs how template source and render context are treated
differently, and the caching optimization deferred to a later stage.

The renderer is one half of the outgoing-notification pipeline: the
[versioned template registry](01-notification-template-versioning.md) supplies the source
string, the renderer produces the rendered string, and the
[`NotificationDelivery`](02-notification-delivery-as-audit-trail.md) row records what was
sent. The Render & Dispatch flow that wires these together is a sibling capability; this
document establishes the rendering seam it depends on.

## 1. Why Handlebars

A notification body like `Order {{orderNumber}} has shipped — track it at {{trackingUrl}}`
is **mostly literal text with a few interpolation holes**. The job is variable
substitution against a small, bounded context object (order numbers, names, addresses,
tracking URLs), not arbitrary computation. That shapes the choice:

- **Handlebars (chosen)** — logic-light by design: a template can interpolate values and
  use a fixed, small set of built-in block helpers (`{{#if}}`, `{{#each}}`), but it
  **cannot run arbitrary JavaScript**. That is exactly the right ceiling for content that
  is authored by staff and stored in a database row: even a trusted author cannot turn a
  template into a code-injection vector. It is a single small dependency, zero-config, and
  its compile/execute path is synchronous — so the port that fronts it stays trivial.
- **EJS (rejected)** — embeds raw JavaScript (`<% ... %>`) directly in the template. That
  makes a stored template body an executable script; a compromised or careless
  `notifications:write` author could embed logic that runs in the notification process.
  The extra expressiveness buys nothing for substitution-shaped content and widens the
  attack surface.
- **JSX / a server-rendered component (rejected)** — pulls a rendering runtime and a build
  step into a backend microservice whose only job is string interpolation. Far too heavy
  for the problem, and templates would have to be code (compiled artifacts), not data
  (DB rows the Author flow can version and roll back).
- **String concatenation / `String.replace` (rejected)** — re-implements an escaping and
  substitution engine by hand. The moment a value needs HTML-escaping (it does — see §3)
  this becomes a security-sensitive wheel that Handlebars already ships, tested.

This decision is recorded in
[ADR-033](../../adr/033-notification-templates-deliveries-and-render-dispatch.md), which
governs the whole notification-template capability.

## 2. The port/adapter seam

The renderer lives behind a port, following the hexagonal layout of
[ADR-004](../../adr/004-adopt-hexagonal-architecture-per-service.md) and the import
boundaries enforced by
[ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md):

- **`ITemplateRendererPort` (`TEMPLATE_RENDERER`)** in `application/ports/` declares the
  one method the Render & Dispatch use case needs:

  ```ts
  render(source: string, context: Record<string, unknown>): string;
  ```

  It imports nothing external — it is a pure TypeScript contract. The signature is
  **synchronous** because Handlebars compile/execute is synchronous; the seam stays as
  simple as the work it fronts.

- **`HandlebarsTemplateRendererAdapter`** in `infrastructure/render/` is the **only file in
  the service that imports `handlebars`**. The architecture lint forbids third-party engine
  imports outside `infrastructure/`, so this confinement is mechanically enforced rather
  than merely conventional. `notifications.module.ts` binds
  `TEMPLATE_RENDERER → HandlebarsTemplateRendererAdapter` (a `useExisting` rebind, the
  `NOTIFIER` precedent).

Why bother with a port for a one-line adapter? Because the consumer — the Render & Dispatch
use case — must be **unit-testable without a real template engine**. With the port, that
use case injects a trivial fake renderer (e.g. one that returns a fixed string) and asserts
the dispatch flow: resolve the template, render, persist the delivery `queued`, call the
transport, flip status. The seam keeps engine concerns (compilation, escaping) out of the
use-case test entirely.

The engine is imported as a namespace (`import * as Handlebars from 'handlebars'`), matching
the project's convention for CommonJS packages (the `argon2` adapter precedent) — the repo's
TypeScript config has `esModuleInterop` off, so a default import would resolve to `undefined`
at runtime.

## 3. Security: trusted source, untrusted data

The single most important property of this renderer is that it treats the **template
source** and the **render context** as having different trust levels:

- **Template source is trusted.** A template body/subject is authored by staff holding
  `notifications:write` and stored in `notification_template`. It is never compiled from
  end-user input. Handlebars' logic-less design means even this trusted source cannot
  execute arbitrary code — a defense-in-depth floor.
- **Render context is data.** The values interpolated into a template — order numbers,
  customer names, shipping addresses — originate from business events and ultimately from
  user-entered data. A customer could name themselves `<script>…</script>`. For any channel
  that renders as HTML (email), emitting that raw would be a stored-XSS vector.

Handlebars' default `{{ }}` interpolation **HTML-escapes** its value (`&`, `<`, `>`, `"`,
`'`, `` ` ``, `=`), which is the correct default here. The renderer spec asserts this
directly: a context value of `<script>alert(1)</script>` renders as
`&lt;script&gt;alert(1)&lt;/script&gt;`.

**The binding rule: never use `{{{ triple-stache }}}` (unescaped output) for
context-derived values.** Triple-stache exists for emitting pre-sanitized HTML the template
*author* controls; it must never be pointed at data. Template content itself is trusted, but
un-sanitized data must never be emitted unescaped. A template that genuinely needs to embed
markup should keep that markup in the (trusted) source, not pull it from the (untrusted)
context.

## 4. Compilation cost and the deferred cache

The adapter **compiles the template source on every call** (`Handlebars.compile(source)`
then invoke). At the current volume this is perfectly acceptable — compilation of a
short body is microseconds, and correctness does not depend on caching.

A **compiled-template cache keyed by template id + version** is a noted future
optimization. The natural home already exists: the unconsumed
`CACHE_KEYS.notificationsTemplate(eventType, channel, locale)` builder
(`NOTIFICATIONS_TEMPLATE_KEY_VERSION = 'v1'` in `libs/cache`) was reserved for a cached
template-resolve read path. Because a template's `(eventType, channel, locale, version)` is
immutable once written (an edit appends a *new* version rather than mutating in place — see
the [versioning document](01-notification-template-versioning.md)), a compiled
`delegate` keyed by id+version can be cached indefinitely with no invalidation concern. That
optimization is out of scope until the notification service wires a `CacheModule`; it is
recorded here so the reserved cache key's purpose is not lost.

## 5. Custom helpers are deliberately absent

The adapter registers **no custom Handlebars helpers or partials**. The built-in
interpolation and block helpers cover what a template body needs today. A money-formatting
helper (`{{money amountMinor currency}}`) or a date helper
(`{{date occurredAt 'long'}}`) is tempting, and would be a reasonable future addition — but
each helper is a small piece of trusted logic that belongs with the renderer, registered in
the adapter. Keeping the set empty now avoids speculative surface; the doc records the
extension point so a later author knows where such helpers go (the adapter, never the
template source).

See [ADR-033](../../adr/033-notification-templates-deliveries-and-render-dispatch.md) for
the whole capability's rationale and the sibling
[template](01-notification-template-versioning.md) /
[delivery](02-notification-delivery-as-audit-trail.md) documents for the registry and audit
trail the renderer sits between.
