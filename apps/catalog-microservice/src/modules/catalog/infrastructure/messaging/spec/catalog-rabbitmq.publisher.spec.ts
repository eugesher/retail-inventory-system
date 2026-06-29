import { ClientProxy } from '@nestjs/microservices';
import { PinoLogger } from 'nestjs-pino';
import { of } from 'rxjs';

import {
  ICatalogProductArchivedEvent,
  ICatalogProductPublishedEvent,
  ICatalogVariantCreatedEvent,
  ICorrelationPayload,
} from '@retail-inventory-system/contracts';
import { RisEventsMirrorPublisher, ROUTING_KEYS } from '@retail-inventory-system/messaging';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { CatalogRabbitmqPublisher } from '../catalog-rabbitmq.publisher';

// Proves the catalog publisher dual-publishes (ADR-035): every event keeps its
// primary default-exchange emit AND mirrors the same routing key + wire onto
// `ris.events`. `catalog.variant.created` rides `inventory_queue`; the two
// `catalog.product.*` events ride `catalog_queue`.
describe('CatalogRabbitmqPublisher dual-publish', () => {
  let catalogEmit: jest.Mock;
  let inventoryEmit: jest.Mock;
  let mirror: RisEventsMirrorPublisher;
  let mirrorSpy: jest.SpyInstance;
  let publisher: CatalogRabbitmqPublisher;

  beforeEach(() => {
    catalogEmit = jest.fn().mockReturnValue(of(undefined));
    inventoryEmit = jest.fn().mockReturnValue(of(undefined));
    mirror = new RisEventsMirrorPublisher(
      { emit: jest.fn().mockReturnValue(of(undefined)) } as unknown as ClientProxy,
      makePinoLoggerMock() as unknown as PinoLogger,
    );
    mirrorSpy = jest.spyOn(mirror, 'mirror');
    publisher = new CatalogRabbitmqPublisher(
      { emit: catalogEmit } as unknown as ClientProxy,
      { emit: inventoryEmit } as unknown as ClientProxy,
      mirror,
    );
  });

  const variantCreated = { correlationId: 'cid' } as unknown as ICatalogVariantCreatedEvent;
  const productPublished = { correlationId: 'cid' } as unknown as ICatalogProductPublishedEvent;
  const productArchived = { correlationId: 'cid' } as unknown as ICatalogProductArchivedEvent;

  interface ICase {
    name: string;
    routingKey: string;
    primary: () => jest.Mock;
    event: ICorrelationPayload;
    invoke: () => Promise<void>;
  }

  const cases: ICase[] = [
    {
      name: 'variant.created',
      routingKey: ROUTING_KEYS.CATALOG_VARIANT_CREATED,
      primary: () => inventoryEmit,
      event: variantCreated,
      invoke: () => publisher.publishVariantCreated(variantCreated),
    },
    {
      name: 'product.published',
      routingKey: ROUTING_KEYS.CATALOG_PRODUCT_PUBLISHED,
      primary: () => catalogEmit,
      event: productPublished,
      invoke: () => publisher.publishProductPublished(productPublished),
    },
    {
      name: 'product.archived',
      routingKey: ROUTING_KEYS.CATALOG_PRODUCT_ARCHIVED,
      primary: () => catalogEmit,
      event: productArchived,
      invoke: () => publisher.publishProductArchived(productArchived),
    },
  ];

  it.each(cases)(
    'mirrors $name onto ris.events alongside the primary emit',
    async ({ routingKey, primary, event, invoke }) => {
      await invoke();

      expect(primary()).toHaveBeenCalledWith(routingKey, event);
      expect(mirrorSpy).toHaveBeenCalledTimes(1);
      expect(mirrorSpy).toHaveBeenCalledWith(routingKey, event);
    },
  );
});
