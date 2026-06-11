// Edge-validation patterns shared by the catalog/pricing request DTOs. Each shape
// the wire contract promises is declared once as a string — the single source for
// the Swagger `pattern:` annotation — and compiled once into the RegExp the
// class-validator `@Matches` decorator consumes, so the documented shape and the
// enforced shape can never drift apart (and the two tax-code DTOs can never drift
// from each other).

// ISO-4217 currency code: three uppercase letters.
export const CURRENCY_CODE_PATTERN = '^[A-Z]{3}$';
export const CURRENCY_CODE_REGEX = new RegExp(CURRENCY_CODE_PATTERN);

// UPPER_SNAKE_CASE classification code: a letter, then letters, digits, or
// underscores.
export const TAX_CATEGORY_CODE_PATTERN = '^[A-Z][A-Z0-9_]*$';
export const TAX_CATEGORY_CODE_REGEX = new RegExp(TAX_CATEGORY_CODE_PATTERN);

// Kebab-case slug: lowercase alphanumeric segments joined by single hyphens. A
// category slug is a path segment (a malformed one would corrupt every
// descendant's materialized `path`), so it is the STRICTER form the catalog
// domain enforces — the edge guard mirrors it here (ADR-029).
export const SLUG_PATTERN = '^[a-z0-9]+(?:-[a-z0-9]+)*$';
export const SLUG_REGEX = new RegExp(SLUG_PATTERN);

// Normalizes a boolean-ish query value for a `class-transformer` `@Transform`. A
// query param always arrives as a STRING (`?root=true` → `'true'`), so a bare
// `@IsBoolean()` would reject it: this maps the recognized tokens to real
// booleans (`'true'`/`'1'` → `true`, `'false'`/`'0'` → `false`), collapses an
// absent/empty value to `undefined` (the "off" default the use case applies), and
// returns any unrecognized token untouched so the following `@IsBoolean()`
// rejects it with a clean 400. The `unknown` param keeps the call site free of
// `no-unsafe-*` leaks (the `@Transform` `value` is typed `any`).
export function parseBooleanQuery(value: unknown): boolean | string | undefined {
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  if (value === undefined || value === null || value === '') return undefined;
  return typeof value === 'string' ? value : undefined;
}
