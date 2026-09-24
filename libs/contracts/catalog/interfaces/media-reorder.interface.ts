import { MediaOwnerTypeEnum } from '../enums';
import { ICorrelationPayload } from '../../microservices';

export interface IReorderMediaPayload extends ICorrelationPayload {
  ownerType: MediaOwnerTypeEnum;
  ownerId: number;
  mediaIdsInOrder: number[];
}
