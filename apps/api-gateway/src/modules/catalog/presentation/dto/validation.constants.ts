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
