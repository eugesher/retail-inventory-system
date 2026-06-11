import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { MediaAssetView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CATALOG_GATEWAY_PORT, IAttachMediaCommand, ICatalogGatewayPort } from '../ports';

@Injectable()
export class AttachMediaUseCase {
  constructor(
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway: ICatalogGatewayPort,
    @InjectPinoLogger(AttachMediaUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    command: IAttachMediaCommand,
    correlationId: string,
  ): Promise<MediaAssetView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(
        { ownerType: command.ownerType, ownerId: command.ownerId, type: command.type },
        'Attaching media asset',
      );

      const media = await this.catalogGateway.attachMedia(command, correlationId);

      this.logger.info({ mediaId: media.id, sortOrder: media.sortOrder }, 'Media asset attached');

      return media;
    } catch (error) {
      this.logger.error(error, 'Error attaching media asset');

      throwRpcError(error);
    }
  }
}
