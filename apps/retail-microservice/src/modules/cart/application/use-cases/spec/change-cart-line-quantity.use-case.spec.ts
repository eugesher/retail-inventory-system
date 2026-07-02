import { PinoLogger } from 'nestjs-pino';

import { CartStatusEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Cart, CartErrorCodeEnum, CartLine } from '../../../domain';
import { ChangeCartLineQuantityUseCase } from '../change-cart-line-quantity.use-case';
import {
  InMemoryCartEventsPublisher,
  InMemoryCartInventoryGateway,
  InMemoryCartRepository,
  makeWireError,
} from './test-doubles';

const CART_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '00000000-0000-4000-a000-000000000002';
const OTHER_ID = '00000000-0000-4000-a000-000000000099';
const LINE_ID = 5000;
const VARIANT_ID = 1;
const MAX_ATTEMPTS = 5;
// The seeded cart starts at version 1 (see `seedCartWithLine`).
const SEED_VERSION = 1;

const seedCartWithLine = (repository: InMemoryCartRepository): void => {
  repository.seed(
    Cart.reconstitute({
      id: CART_ID,
      customerId: OWNER_ID,
      currency: 'USD',
      status: CartStatusEnum.ACTIVE,
      lines: [
        new CartLine({
          id: LINE_ID,
          variantId: VARIANT_ID,
          quantity: 3,
          unitPriceSnapshotMinor: 4999,
          currencySnapshot: 'USD',
        }),
      ],
      version: 1,
    }),
  );
};

describe('ChangeCartLineQuantityUseCase', () => {
  let repository: InMemoryCartRepository;
  let inventory: InMemoryCartInventoryGateway;
  let publisher: InMemoryCartEventsPublisher;
  let logger: PinoLoggerMock;
  let useCase: ChangeCartLineQuantityUseCase;

  beforeEach(() => {
    repository = new InMemoryCartRepository();
    inventory = new InMemoryCartInventoryGateway();
    publisher = new InMemoryCartEventsPublisher();
    logger = makePinoLoggerMock();
    useCase = new ChangeCartLineQuantityUseCase(
      repository,
      inventory,
      publisher,
      MAX_ATTEMPTS,
      logger as unknown as PinoLogger,
    );
    seedCartWithLine(repository);
  });

  it('re-reserves the absolute new quantity (down), sets the line, and emits the event', async () => {
    const view = await useCase.execute({
      cartId: CART_ID,
      customerId: OWNER_ID,
      lineId: LINE_ID,
      quantity: 1,
      correlationId: 'corr-1',
    });

    expect(view.lines).toHaveLength(1);
    expect(view.lines[0].quantity).toBe(1);
    expect(view.subtotalMinor).toBe(4999);

    // The reserve carried the ABSOLUTE new quantity (1), not a delta, keyed on the
    // line's variant.
    expect(inventory.reserveCalls).toEqual([
      { variantId: VARIANT_ID, quantity: 1, cartId: CART_ID, correlationId: 'corr-1' },
    ]);

    expect(publisher.lineQuantityChanged).toHaveLength(1);
    const [{ event }] = publisher.lineQuantityChanged;
    expect(event.cartId).toBe(CART_ID);
    expect(event.lineId).toBe(LINE_ID);
    expect(event.quantity).toBe(1);
    expect(event.eventVersion).toBe('v1');
  });

  it('re-reserves the absolute new quantity (up)', async () => {
    const view = await useCase.execute({
      cartId: CART_ID,
      customerId: OWNER_ID,
      lineId: LINE_ID,
      quantity: 7,
      correlationId: 'corr-1',
    });

    expect(view.lines[0].quantity).toBe(7);
    expect(inventory.reserveCalls).toEqual([
      { variantId: VARIANT_ID, quantity: 7, cartId: CART_ID, correlationId: 'corr-1' },
    ]);
  });

  it('reserves BEFORE persisting the cart', async () => {
    const reserveSpy = jest.spyOn(inventory, 'reserveStock');
    const saveSpy = jest.spyOn(repository, 'save');

    await useCase.execute({
      cartId: CART_ID,
      customerId: OWNER_ID,
      lineId: LINE_ID,
      quantity: 2,
      correlationId: 'corr-1',
    });

    expect(reserveSpy.mock.invocationCallOrder[0]).toBeLessThan(
      saveSpy.mock.invocationCallOrder[0],
    );
  });

  it('propagates an INVENTORY_OUT_OF_STOCK reserve rejection and never saves the cart', async () => {
    inventory.reserveError = makeWireError('INVENTORY_OUT_OF_STOCK', 409, 'Out of stock', {
      available: 4,
    });

    await expect(
      useCase.execute({
        cartId: CART_ID,
        customerId: OWNER_ID,
        lineId: LINE_ID,
        quantity: 9,
        correlationId: 'corr-2',
      }),
    ).rejects.toMatchObject({ code: 'INVENTORY_OUT_OF_STOCK', details: { available: 4 } });

    expect(repository.saved).toHaveLength(0);
    expect(publisher.lineQuantityChanged).toHaveLength(0);
  });

  it('rejects an unknown line with CART_LINE_NOT_FOUND before reserving', async () => {
    await expect(
      useCase.execute({
        cartId: CART_ID,
        customerId: OWNER_ID,
        lineId: 999999,
        quantity: 1,
        correlationId: 'corr-2',
      }),
    ).rejects.toMatchObject({ code: CartErrorCodeEnum.CART_LINE_NOT_FOUND });

    expect(inventory.reserveCalls).toHaveLength(0);
    expect(repository.saved).toHaveLength(0);
  });

  it('rejects quantity 0 before saving (the reserve RPC guards it; the gateway @Min(1) is the edge gate)', async () => {
    // With reserve-before-mutate a `0` is rejected by the reserve RPC's positive-int
    // guard before the domain backstop is reached; either way nothing is saved. In
    // production the gateway DTO's `@Min(1)` rejects `0` at the edge first.
    await expect(
      useCase.execute({
        cartId: CART_ID,
        customerId: OWNER_ID,
        lineId: LINE_ID,
        quantity: 0,
        correlationId: 'corr-2',
      }),
    ).rejects.toMatchObject({ code: 'INVENTORY_RESERVATION_QUANTITY_INVALID' });

    expect(repository.saved).toHaveLength(0);
    expect(publisher.lineQuantityChanged).toHaveLength(0);
  });

  it('rejects a non-owner with CART_ACCESS_FORBIDDEN before reserving', async () => {
    await expect(
      useCase.execute({
        cartId: CART_ID,
        customerId: OTHER_ID,
        lineId: LINE_ID,
        quantity: 1,
        correlationId: 'corr-3',
      }),
    ).rejects.toMatchObject({ code: CartErrorCodeEnum.CART_ACCESS_FORBIDDEN });

    expect(inventory.reserveCalls).toHaveLength(0);
  });

  describe('optimistic concurrency (ADR-036)', () => {
    it('honors a matching If-Match version and persists at the bumped version', async () => {
      const view = await useCase.execute({
        cartId: CART_ID,
        customerId: OWNER_ID,
        lineId: LINE_ID,
        quantity: 2,
        expectedVersion: SEED_VERSION,
        correlationId: 'corr-ok',
      });

      expect(view.lines[0].quantity).toBe(2);
      expect(view.version).toBe(SEED_VERSION + 1);
      expect(inventory.reserveCalls).toHaveLength(1);
    });

    it('rejects a stale If-Match with 409 VERSION_MISMATCH and does NOT retry or touch stock', async () => {
      await expect(
        useCase.execute({
          cartId: CART_ID,
          customerId: OWNER_ID,
          lineId: LINE_ID,
          quantity: 2,
          expectedVersion: SEED_VERSION - 1, // stale — the cart is at SEED_VERSION
          correlationId: 'corr-stale',
        }),
      ).rejects.toMatchObject({
        code: CartErrorCodeEnum.CART_VERSION_MISMATCH,
        details: { currentVersion: SEED_VERSION },
      });

      expect(inventory.reserveCalls).toHaveLength(0);
      expect(repository.saved).toHaveLength(0);
      expect(publisher.lineQuantityChanged).toHaveLength(0);
    });

    it('retries a lost race (no If-Match) and succeeds within the budget', async () => {
      repository.conflictsBeforeSuccess = 1;

      const view = await useCase.execute({
        cartId: CART_ID,
        customerId: OWNER_ID,
        lineId: LINE_ID,
        quantity: 2,
        correlationId: 'corr-retry',
      });

      expect(view.lines[0].quantity).toBe(2);
      expect(inventory.reserveCalls).toHaveLength(2);
      expect(repository.saved).toHaveLength(1);
      expect(publisher.lineQuantityChanged).toHaveLength(1);
    });

    it('surfaces 409 VERSION_MISMATCH with the current version after the retry budget is exhausted', async () => {
      repository.conflictsBeforeSuccess = 99;

      await expect(
        useCase.execute({
          cartId: CART_ID,
          customerId: OWNER_ID,
          lineId: LINE_ID,
          quantity: 2,
          correlationId: 'corr-exhaust',
        }),
      ).rejects.toMatchObject({
        code: CartErrorCodeEnum.CART_VERSION_MISMATCH,
        details: { currentVersion: SEED_VERSION + MAX_ATTEMPTS },
      });

      expect(inventory.reserveCalls).toHaveLength(MAX_ATTEMPTS);
      expect(repository.saved).toHaveLength(0);
    });
  });
});
