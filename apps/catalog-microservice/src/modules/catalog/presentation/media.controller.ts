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

// Thin RMQ entry points for the media operations, on `catalog_queue`. A SEPARATE
// controller from `catalog.controller.ts` / `category.controller.ts` keeps each
// file one-aggregate-shaped (Product vs. Category vs. MediaAsset); the
// `APP_FILTER`-registered `CatalogRpcExceptionFilter` already covers every
// controller in the module, so the `MEDIA_*` codes map to HTTP without extra
// wiring. The handlers translate the wire payload into the use-case call;
// `correlationId` is logged inline inside each use case (`PinoLogger.assign()`
// throws outside request scope — ADR-001 / ADR-011), so the controller carries no
// logging of its own.
//
// Like the category surface, the media capability emits NO events (ADR-029 §6).
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
