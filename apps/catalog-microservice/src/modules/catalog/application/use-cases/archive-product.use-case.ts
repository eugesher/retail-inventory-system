import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IArchiveProductPayload, ProductView } from '@retail-inventory-system/contracts';

import { CatalogDomainException, CatalogErrorCodeEnum, ProductArchivedEvent } from '../../domain';
import {
  CATALOG_EVENTS_PUBLISHER,
  CATALOG_REPOSITORY,
  ICatalogEventsPublisherPort,
  ICatalogRepositoryPort,
} from '../ports';
import { toProductView } from './catalog-view.factory';

@Injectable()
export class ArchiveProductUseCase {
  constructor(
    @Inject(CATALOG_REPOSITORY)
    private readonly repository: ICatalogRepositoryPort,
    @Inject(CATALOG_EVENTS_PUBLISHER)
    private readonly publisher: ICatalogEventsPublisherPort,
    @InjectPinoLogger(ArchiveProductUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IArchiveProductPayload): Promise<ProductView> {
    const { productId, correlationId } = payload;

    this.logger.info({ correlationId, productId }, 'Received RPC: archive product');

    const product = await this.repository.findById(productId);
    if (product === null) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.PRODUCT_NOT_FOUND,
        `Product #${productId} not found`,
      );
    }

    product.archive();

    const saved = await this.repository.save(product);

    this.logger.info({ correlationId, productId }, 'Product archived');

    const events = product.pullDomainEvents();
    const archivedEvent = events.find(
      (event): event is ProductArchivedEvent => event instanceof ProductArchivedEvent,
    );
    if (archivedEvent === undefined) {
      throw new Error('ArchiveProductUseCase: ProductArchivedEvent missing after archive()');
    }

    const archivedAt = archivedEvent.occurredAt.toISOString();

    try {
      await this.publisher.publishProductArchived(
        {
          productId,
          archivedAt,
          eventVersion: 'v1',
          occurredAt: archivedAt,
          correlationId: correlationId ?? '',
        },
        correlationId,
      );
    } catch (err) {
      this.logger.warn(
        { err: err as Error, correlationId, productId },
        'Failed to publish catalog.product.archived event',
      );
    }

    return { ...toProductView(saved), archivedAt };
  }
}
