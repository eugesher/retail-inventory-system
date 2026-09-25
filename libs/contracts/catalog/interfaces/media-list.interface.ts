import { MediaOwnerTypeEnum } from '../enums';
import { ICorrelationPayload } from '../../microservices';

export interface IMediaListQuery extends ICorrelationPayload {
  ownerType: MediaOwnerTypeEnum;
  ownerId: number;
}
