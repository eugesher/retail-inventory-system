import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import {
  IAttachMediaPayload,
  IDetachMediaPayload,
  IMediaListQuery,
  IReorderMediaPayload,
  MediaAssetView,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import {
  AttachMediaUseCase,
  DetachMediaUseCase,
  ListMediaUseCase,
  ReorderMediaUseCase,
} from '../application/use-cases';

@Controller()
export class MediaController {
  constructor(
    private readonly attachMediaUseCase: AttachMediaUseCase,
    private readonly reorderMediaUseCase: ReorderMediaUseCase,
    private readonly detachMediaUseCase: DetachMediaUseCase,
    private readonly listMediaUseCase: ListMediaUseCase,
  ) {}

  @MessagePattern(ROUTING_KEYS.CATALOG_MEDIA_ATTACH)
  public async attachMedia(@Payload() payload: IAttachMediaPayload): Promise<MediaAssetView> {
    return this.attachMediaUseCase.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.CATALOG_MEDIA_REORDER)
  public async reorderMedia(@Payload() payload: IReorderMediaPayload): Promise<MediaAssetView[]> {
    return this.reorderMediaUseCase.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.CATALOG_MEDIA_DETACH)
  public async detachMedia(@Payload() payload: IDetachMediaPayload): Promise<MediaAssetView> {
    return this.detachMediaUseCase.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.CATALOG_MEDIA_LIST)
  public async listMedia(@Payload() query: IMediaListQuery): Promise<MediaAssetView[]> {
    return this.listMediaUseCase.execute(query);
  }
}
