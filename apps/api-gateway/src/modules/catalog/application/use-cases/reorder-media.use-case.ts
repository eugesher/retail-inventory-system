import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { MediaAssetView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CATALOG_GATEWAY_PORT, ICatalogGatewayPort, IReorderMediaCommand } from '../ports';

@Injectable()
export class ReorderMediaUseCase {
  constructor(
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway: ICatalogGatewayPort,
    @InjectPinoLogger(ReorderMediaUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    command: IReorderMediaCommand,
    correlationId: string,
  ): Promise<MediaAssetView[]> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(
        {
          ownerType: command.ownerType,
          ownerId: command.ownerId,
          count: command.mediaIdsInOrder.length,
        },
        'Reordering media strip',
      );

      const media = await this.catalogGateway.reorderMedia(command, correlationId);

      this.logger.info({ count: media.length }, 'Media strip reordered');

      return media;
    } catch (error) {
      this.logger.error(error, 'Error reordering media strip');

      throwRpcError(error);
    }
  }
}
