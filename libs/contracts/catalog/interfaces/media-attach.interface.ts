import { MediaAssetTypeEnum, MediaOwnerTypeEnum } from '../enums';
import { ICorrelationPayload } from '../../microservices';

export interface IAttachMediaPayload extends ICorrelationPayload {
  ownerType: MediaOwnerTypeEnum;
  ownerId: number;
  uri: string;
  type: MediaAssetTypeEnum;
  altText?: string;
}
