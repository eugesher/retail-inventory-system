import { PinoLogger } from 'nestjs-pino';

import { CartStatusEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Cart, CartErrorCodeEnum } from '../../../domain';
import { AddToCartUseCase } from '../add-to-cart.use-case';
import {
  InMemoryCartCatalogGateway,
  InMemoryCartEventsPublisher,
  InMemoryCartRepository,
} from './test-doubles';

const CART_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '00000000-0000-4000-a000-000000000002';
const OTHER_ID = '00000000-0000-4000-a000-000000000099';

describe('AddToCartUseCase', () => {
  let repository: InMemoryCartRepository;
  let catalog: InMemoryCartCatalogGateway;
  let publisher: InMemoryCartEventsPublisher;
  let logger: PinoLoggerMock;
  let useCase: AddToCartUseCase;

  beforeEach(() => {
    repository = new InMemoryCartRepository();
    catalog = new InMemoryCartCatalogGateway();
    publisher = new InMemoryCartEventsPublisher();
    logger = makePinoLoggerMock();
    useCase = new AddToCartUseCase(repository, catalog, publisher, logger as unknown as PinoLogger);

    repository.seed(
      Cart.reconstitute({
        id: CART_ID,
        customerId: OWNER_ID,
        currency: 'USD',
        status: CartStatusEnum.ACTIVE,
        lines: [],
        version: 0,
      }),
    );
  });

  it('snapshots the applicable price, adds the line, and emits retail.cart.line-added', async () => {
    const view = await useCase.execute({
      cartId: CART_ID,
      customerId: OWNER_ID,
      variantId: 1,
      quantity: 2,
      correlationId: 'corr-1',
    });

    expect(view.lines).toHaveLength(1);
    const [line] = view.lines;
    expect(line.variantId).toBe(1);
    expect(line.quantity).toBe(2);
    // Snapshot price comes from catalog.price.select (default $49.99), not the caller.
    expect(line.unitPriceSnapshotMinor).toBe(4999);
    expect(line.currencySnapshot).toBe('USD');
    expect(view.subtotalMinor).toBe(9998);

    // The price was resolved in the cart's currency.
    expect(catalog.calls).toEqual([{ variantId: 1, currency: 'USD', correlationId: 'corr-1' }]);

    expect(publisher.lineAdded).toHaveLength(1);
    const [{ event }] = publisher.lineAdded;
    expect(event.cartId).toBe(CART_ID);
    expect(event.variantId).toBe(1);
    expect(event.quantity).toBe(2);
    expect(event.eventVersion).toBe('v1');
  });

  it('rejects when the variant has no applicable price (unknown/unpriced)', async () => {
    catalog.nextPrice = null;

    await expect(
      useCase.execute({
        cartId: CART_ID,
        customerId: OWNER_ID,
        variantId: 999,
        quantity: 1,
        correlationId: 'corr-2',
      }),
    ).rejects.toMatchObject({ code: CartErrorCodeEnum.CART_VARIANT_NOT_PRICED });

    // Nothing persisted, nothing emitted.
    expect(repository.saved).toHaveLength(0);
    expect(publisher.lineAdded).toHaveLength(0);
  });

  it('rejects a non-owner with CART_ACCESS_FORBIDDEN', async () => {
    await expect(
      useCase.execute({
        cartId: CART_ID,
        customerId: OTHER_ID,
        variantId: 1,
        quantity: 1,
        correlationId: 'corr-3',
      }),
    ).rejects.toMatchObject({ code: CartErrorCodeEnum.CART_ACCESS_FORBIDDEN });

    // The owner-check fires before the catalog is consulted.
    expect(catalog.calls).toHaveLength(0);
    expect(publisher.lineAdded).toHaveLength(0);
  });
});
