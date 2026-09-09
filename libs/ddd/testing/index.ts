// Test-only helpers — kept out of `libs/ddd/index.ts` on purpose so production code never imports
// them. Specs reach this barrel via the deep path `@retail-inventory-system/ddd/testing`, the same
// arrangement as `@retail-inventory-system/observability/testing`.
export * from './as-reconstituted';
