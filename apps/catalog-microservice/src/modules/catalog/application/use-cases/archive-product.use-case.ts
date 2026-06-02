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

// Archive Product flips a product `active → archived` — the catalog's terminal
// soft-delete. The domain (`Product.archive`) rejects archiving a non-active
// product. An archived product is hidden from the browse list (the read path
// filters on `status = active`) but stays resolvable by id/slug, so the use case
// emits `catalog.product.archived` for any consumer that needs to react (e.g.
// delist). The publish is best-effort post-commit — a broker failure is
// warn-logged and swallowed, the product stays archived regardless
// (ADR-020 / ADR-025).
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

    // Domain transition: rejects a non-active product, and records a
    // `ProductArchivedEvent` on success.
    product.archive();

    const saved = await this.repository.save(product);

    this.logger.info({ correlationId, productId }, 'Product archived');

    // Drain the in-process events and map the archive to its versioned wire
    // event. `archive()` records exactly one `ProductArchivedEvent`.
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
      // Publish failures never raise — the product is already archived.
      this.logger.warn(
        { err: err as Error, correlationId, productId },
        'Failed to publish catalog.product.archived event',
      );
    }

    return {
      id: saved.id ?? productId,
      name: saved.name,
      slug: saved.slug,
      description: saved.description,
      status: saved.status,
      archivedAt,
    };
  }
}
