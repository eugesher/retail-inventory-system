import { PinoLogger } from 'nestjs-pino';

import { CartStatusEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Cart, CartErrorCodeEnum, CartLine } from '../../../domain';
import { RemoveFromCartUseCase } from '../remove-from-cart.use-case';
import {
  InMemoryCartEventsPublisher,
  InMemoryCartInventoryGateway,
  InMemoryCartRepository,
} from './test-doubles';

const CART_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '00000000-0000-4000-a000-000000000002';
const OTHER_ID = '00000000-0000-4000-a000-000000000099';
const LINE_ID = 5000;
const LINE_VARIANT_ID = 1;
const OTHER_LINE_ID = 5001;

const seedCartWithTwoLines = (repository: InMemoryCartRepository): void => {
  repository.seed(
    Cart.reconstitute({
      id: CART_ID,
      customerId: OWNER_ID,
      currency: 'USD',
      status: CartStatusEnum.ACTIVE,
      lines: [
        new CartLine({
          id: LINE_ID,
          variantId: LINE_VARIANT_ID,
          quantity: 2,
          unitPriceSnapshotMinor: 4999,
          currencySnapshot: 'USD',
        }),
        new CartLine({
          id: OTHER_LINE_ID,
          variantId: 2,
          quantity: 1,
          unitPriceSnapshotMinor: 1999,
          currencySnapshot: 'USD',
        }),
      ],
      version: 2,
    }),
  );
};

describe('RemoveFromCartUseCase', () => {
  let repository: InMemoryCartRepository;
  let inventory: InMemoryCartInventoryGateway;
  let publisher: InMemoryCartEventsPublisher;
  let logger: PinoLoggerMock;
  let useCase: RemoveFromCartUseCase;

  beforeEach(() => {
    repository = new InMemoryCartRepository();
    inventory = new InMemoryCartInventoryGateway();
    publisher = new InMemoryCartEventsPublisher();
    logger = makePinoLoggerMock();
    useCase = new RemoveFromCartUseCase(
      repository,
      inventory,
      publisher,
      logger as unknown as PinoLogger,
    );
    seedCartWithTwoLines(repository);
  });

  it('drops the right line, releases its hold after save, and emits retail.cart.line-removed', async () => {
    const releaseSpy = jest.spyOn(inventory, 'releaseStock');
    const saveSpy = jest.spyOn(repository, 'save');

    const view = await useCase.execute({
      cartId: CART_ID,
      customerId: OWNER_ID,
      lineId: LINE_ID,
      correlationId: 'corr-1',
    });

    expect(view.lines).toHaveLength(1);
    expect(view.lines[0].id).toBe(OTHER_LINE_ID);

    // Release was called by cartId + the removed line's variant, reason cart-removed.
    expect(inventory.releaseCalls).toEqual([
      {
        cartId: CART_ID,
        variantId: LINE_VARIANT_ID,
        reason: 'cart-removed',
        correlationId: 'corr-1',
      },
    ]);
    // Release runs AFTER the cart write (the cart write is the primary outcome).
    expect(releaseSpy.mock.invocationCallOrder[0]).toBeGreaterThan(
      saveSpy.mock.invocationCallOrder[0],
    );

    expect(publisher.lineRemoved).toHaveLength(1);
    const [{ event }] = publisher.lineRemoved;
    expect(event.cartId).toBe(CART_ID);
    expect(event.lineId).toBe(LINE_ID);
    expect(event.eventVersion).toBe('v1');
  });

  it('swallows a release failure and still returns the view (best-effort)', async () => {
    inventory.releaseError = new Error('inventory unreachable');

    const view = await useCase.execute({
      cartId: CART_ID,
      customerId: OWNER_ID,
      lineId: LINE_ID,
      correlationId: 'corr-1',
    });

    // The remove succeeded despite the release failure.
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0].id).toBe(OTHER_LINE_ID);
    expect(repository.saved).toHaveLength(1);
    // The failure was warn-logged, not raised.
    expect(logger.warn).toHaveBeenCalled();
  });

  it('does not call release when the line lookup fails (CART_LINE_NOT_FOUND)', async () => {
    await expect(
      useCase.execute({
        cartId: CART_ID,
        customerId: OWNER_ID,
        lineId: 999999,
        correlationId: 'corr-2',
      }),
    ).rejects.toMatchObject({ code: CartErrorCodeEnum.CART_LINE_NOT_FOUND });

    expect(inventory.releaseCalls).toHaveLength(0);
    expect(publisher.lineRemoved).toHaveLength(0);
  });

  it('rejects a non-owner with CART_ACCESS_FORBIDDEN before touching inventory', async () => {
    await expect(
      useCase.execute({
        cartId: CART_ID,
        customerId: OTHER_ID,
        lineId: LINE_ID,
        correlationId: 'corr-3',
      }),
    ).rejects.toMatchObject({ code: CartErrorCodeEnum.CART_ACCESS_FORBIDDEN });

    expect(inventory.releaseCalls).toHaveLength(0);
  });
});
