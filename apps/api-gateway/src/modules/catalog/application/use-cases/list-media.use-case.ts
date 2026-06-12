import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { MediaAssetView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CATALOG_GATEWAY_PORT, ICatalogGatewayPort, IListMediaCommand } from '../ports';

// Backs BOTH media GET routes — `GET /products/:productId/media` and
// `GET /variants/:variantId/media` — the controller folds the matching
// `ownerType` so one use case serves both owner kinds (ADR-029 §4).
@Injectable()
export class ListMediaUseCase {
  constructor(
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway: ICatalogGatewayPort,
    @InjectPinoLogger(ListMediaUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(query: IListMediaCommand, correlationId: string): Promise<MediaAssetView[]> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(
        { ownerType: query.ownerType, ownerId: query.ownerId },
        'Listing media for owner',
      );

      const media = await this.catalogGateway.listMedia(query, correlationId);

      this.logger.info({ count: media.length }, 'Media listed for owner');

      return media;
    } catch (error) {
      this.logger.error(error, 'Error listing media for owner');

      throwRpcError(error);
    }
  }
}
