import { ICorrelationPayload } from '../../microservices';

export interface ICatalogProductArchivedEvent extends ICorrelationPayload {
  productId: number;
  archivedAt: string;
  eventVersion: 'v1';
  occurredAt: string;
}
