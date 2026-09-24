import { ICorrelationPayload } from '../../microservices';

export interface IReservationSweepPayload extends ICorrelationPayload {
  batchSize?: number;
  actorId?: string | null;
}
