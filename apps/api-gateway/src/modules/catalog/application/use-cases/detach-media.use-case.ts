import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { MediaAssetView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CATALOG_GATEWAY_PORT, ICatalogGatewayPort } from '../ports';

@Injectable()
export class DetachMediaUseCase {
  constructor(
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway: ICatalogGatewayPort,
    @InjectPinoLogger(DetachMediaUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(mediaId: number, correlationId: string): Promise<MediaAssetView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info({ mediaId }, 'Detaching media asset');

      const media = await this.catalogGateway.detachMedia(mediaId, correlationId);

      this.logger.info({ mediaId: media.id, status: media.status }, 'Media asset detached');

      return media;
    } catch (error) {
      this.logger.error(error, 'Error detaching media asset');

      throwRpcError(error);
    }
  }
}
