import { PinoLogger } from 'nestjs-pino';

import { CartStatusEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Cart, CartErrorCodeEnum, CartLine } from '../../../domain';
import { AddToCartUseCase } from '../add-to-cart.use-case';
import {
  InMemoryCartCatalogGateway,
  InMemoryCartEventsPublisher,
  InMemoryCartInventoryGateway,
  InMemoryCartRepository,
  makeWireError,
} from './test-doubles';

const CART_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '00000000-0000-4000-a000-000000000002';
const OTHER_ID = '00000000-0000-4000-a000-000000000099';

describe('AddToCartUseCase', () => {
  let repository: InMemoryCartRepository;
  let catalog: InMemoryCartCatalogGateway;
  let inventory: InMemoryCartInventoryGateway;
  let publisher: InMemoryCartEventsPublisher;
  let logger: PinoLoggerMock;
  let useCase: AddToCartUseCase;

  beforeEach(() => {
    repository = new InMemoryCartRepository();
    catalog = new InMemoryCartCatalogGateway();
    inventory = new InMemoryCartInventoryGateway();
    publisher = new InMemoryCartEventsPublisher();
    logger = makePinoLoggerMock();
    useCase = new AddToCartUseCase(
      repository,
      catalog,
      inventory,
      publisher,
      logger as unknown as PinoLogger,
    );

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

  it('snapshots the applicable price, reserves the line, adds it, and emits retail.cart.line-added', async () => {
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

    // A fresh line reserves exactly the payload quantity (absolute target), keyed
    // on the cart, with no explicit location (inventory defaults it).
    expect(inventory.reserveCalls).toEqual([
      { variantId: 1, quantity: 2, cartId: CART_ID, correlationId: 'corr-1' },
    ]);

    expect(publisher.lineAdded).toHaveLength(1);
    const [{ event }] = publisher.lineAdded;
    expect(event.cartId).toBe(CART_ID);
    expect(event.variantId).toBe(1);
    expect(event.quantity).toBe(2);
    expect(event.eventVersion).toBe('v1');
  });

  it('reserves the ABSOLUTE target (existing qty + this add) when incrementing an existing line', async () => {
    repository.seed(
      Cart.reconstitute({
        id: CART_ID,
        customerId: OWNER_ID,
        currency: 'USD',
        status: CartStatusEnum.ACTIVE,
        lines: [
          new CartLine({
            id: 5000,
            variantId: 1,
            quantity: 3,
            unitPriceSnapshotMinor: 4999,
            currencySnapshot: 'USD',
          }),
        ],
        version: 1,
      }),
    );

    const view = await useCase.execute({
      cartId: CART_ID,
      customerId: OWNER_ID,
      variantId: 1,
      quantity: 2,
      correlationId: 'corr-1',
    });

    // The single line is now 5 units, and the reserve carried the absolute 5 (3 + 2).
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0].quantity).toBe(5);
    expect(inventory.reserveCalls).toEqual([
      { variantId: 1, quantity: 5, cartId: CART_ID, correlationId: 'corr-1' },
    ]);
  });

  it('reserves BEFORE persisting the cart', async () => {
    const reserveSpy = jest.spyOn(inventory, 'reserveStock');
    const saveSpy = jest.spyOn(repository, 'save');

    await useCase.execute({
      cartId: CART_ID,
      customerId: OWNER_ID,
      variantId: 1,
      quantity: 1,
      correlationId: 'corr-1',
    });

    expect(reserveSpy.mock.invocationCallOrder[0]).toBeLessThan(
      saveSpy.mock.invocationCallOrder[0],
    );
  });

  it('propagates an INVENTORY_OUT_OF_STOCK reserve rejection and never saves the cart', async () => {
    inventory.reserveError = makeWireError('INVENTORY_OUT_OF_STOCK', 409, 'Out of stock', {
      available: 1,
    });

    await expect(
      useCase.execute({
        cartId: CART_ID,
        customerId: OWNER_ID,
        variantId: 1,
        quantity: 5,
        correlationId: 'corr-2',
      }),
    ).rejects.toMatchObject({ code: 'INVENTORY_OUT_OF_STOCK', details: { available: 1 } });

    // The reserve was attempted, but nothing was persisted or emitted.
    expect(inventory.reserveCalls).toHaveLength(1);
    expect(repository.saved).toHaveLength(0);
    expect(publisher.lineAdded).toHaveLength(0);
  });

  it('rejects when the variant has no applicable price (unknown/unpriced) before reserving', async () => {
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

    // The price gate fires before the reserve; nothing persisted, nothing emitted.
    expect(inventory.reserveCalls).toHaveLength(0);
    expect(repository.saved).toHaveLength(0);
    expect(publisher.lineAdded).toHaveLength(0);
  });

  it('rejects a non-owner with CART_ACCESS_FORBIDDEN before consulting catalog/inventory', async () => {
    await expect(
      useCase.execute({
        cartId: CART_ID,
        customerId: OTHER_ID,
        variantId: 1,
        quantity: 1,
        correlationId: 'corr-3',
      }),
    ).rejects.toMatchObject({ code: CartErrorCodeEnum.CART_ACCESS_FORBIDDEN });

    // The owner-check fires before the catalog AND the inventory are consulted.
    expect(catalog.calls).toHaveLength(0);
    expect(inventory.reserveCalls).toHaveLength(0);
    expect(publisher.lineAdded).toHaveLength(0);
  });
});
