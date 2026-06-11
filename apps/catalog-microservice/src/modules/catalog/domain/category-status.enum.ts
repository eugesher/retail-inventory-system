// Lifecycle states for a catalog Category.
//
// Soft-delete is modelled as the terminal `ARCHIVED` state — there is no
// `deletedAt` timestamp on the aggregate (the inherited persistence column is
// left inert; see the persistence work and ADR-025). An archived category stays
// resolvable forever because a product membership or a historical reference may
// still point at its id, so an archived category must never become unreachable.
//
// This enum lives in the catalog `domain/` (not `libs/contracts`) on purpose:
// it is an internal domain concept, not a cross-service wire contract. The
// later use-case layer maps it onto whatever DTO/view shape goes over RabbitMQ
// (ADR-025 §7).
export enum CategoryStatusEnum {
  ACTIVE = 'active',
  ARCHIVED = 'archived',
}
