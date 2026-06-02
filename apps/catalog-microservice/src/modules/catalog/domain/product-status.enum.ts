// Lifecycle states for a catalog Product.
//
// Soft-delete is modelled as the terminal `ARCHIVED` state — there is no
// `deletedAt` timestamp on the aggregate (the inherited persistence column is
// left inert; see the persistence work and ADR-025). Archived rows stay
// resolvable forever because historical orders and stock reference variants by
// id, so an archived product must never become unreachable.
//
// This enum lives in the catalog `domain/` (not `libs/contracts`) on purpose:
// it is an internal domain concept, not a cross-service wire contract. The
// later use-case layer maps it onto whatever DTO/event shape goes over RabbitMQ.
export enum ProductStatusEnum {
  DRAFT = 'draft',
  ACTIVE = 'active',
  ARCHIVED = 'archived',
}
