// Lifecycle states for a ProductVariant.
//
// Variants are created `ACTIVE`. Variant-level archival is not a write
// operation at this stage: the `ARCHIVED` member is modelled so persistence and
// future flows have the full vocabulary, but the only transition exercised
// today is construction (a variant is born active). Soft-delete is via status,
// never a `deletedAt` timestamp (ADR-025).
export enum ProductVariantStatusEnum {
  ACTIVE = 'active',
  ARCHIVED = 'archived',
}
