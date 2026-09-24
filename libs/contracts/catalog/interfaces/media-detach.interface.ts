import { ICorrelationPayload } from '../../microservices';

export interface IDetachMediaPayload extends ICorrelationPayload {
  mediaId: number;
}
