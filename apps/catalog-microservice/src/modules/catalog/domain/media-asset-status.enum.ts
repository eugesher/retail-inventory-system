// Lifecycle states for a catalog MediaAsset.
//
// Soft-delete is modelled as the terminal `ARCHIVED` state — there is no
// `deletedAt` timestamp on the aggregate, and `BaseEntity`'s inherited `deleted_at` column stays
// inert (`MediaAssetEntity` says so; nothing in catalog ever soft-deletes). Detach archives
// the row rather than deleting it, so anything that captured the media id
// historically still resolves it; an archived asset never reappears in a browse
// (the list read filters to `active`).
//
// This enum lives in the catalog `domain/` (not `libs/contracts`) on purpose: it
// is an internal domain concept, not a cross-service wire contract — the wire
// `MediaAssetView` carries the raw status string. This DIVERGES from the two
// media wire enums (`MediaOwnerTypeEnum` / `MediaAssetTypeEnum`), which DO ride
// the RPC payloads and so live in `libs/contracts` (ADR-025 §7).
export enum MediaAssetStatusEnum {
  ACTIVE = 'active',
  ARCHIVED = 'archived',
}
