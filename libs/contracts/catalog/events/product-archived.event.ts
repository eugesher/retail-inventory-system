import { ICorrelationPayload } from '../../microservices';

// `catalog.product.archived` — a **reserved surface** (README §2). Not dead code.
//
// Archiving is the catalog's terminal **soft-delete**: the product drops out of the browse list
// but stays resolvable by id and slug, so an order line placed years ago can still name it.
//
// `archivedAt` is the business instant of the `active → archived` transition; `occurredAt` is the
// envelope's. They are separate fields carrying the same value, and a consumer must not assume
// they always will.
export interface ICatalogProductArchivedEvent extends ICorrelationPayload {
  productId: number;
  archivedAt: string;
  eventVersion: 'v1';
  occurredAt: string;
}
