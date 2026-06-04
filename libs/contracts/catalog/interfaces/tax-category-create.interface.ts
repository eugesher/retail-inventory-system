import { ICorrelationPayload } from '../../microservices';

// Wire-format command payload for `catalog.tax-category.create` (API Gateway →
// Catalog). A `TaxCategory` is a classification label only — code + name (+ an
// optional description); it carries no rate or jurisdiction (ADR-026).
//
// `code` is the stable, machine-facing identifier in UPPER_SNAKE_CASE (matching
// `^[A-Z][A-Z0-9_]*$`); the domain rejects a malformed code
// (`TAX_CATEGORY_CODE_INVALID`) and the use case rejects a duplicate against the
// repository (`TAX_CATEGORY_CODE_TAKEN`). `name` is the human-facing label
// (non-empty). `description` is optional free text.
export interface ICreateTaxCategoryPayload extends ICorrelationPayload {
  code: string;
  name: string;
  description?: string;
}
