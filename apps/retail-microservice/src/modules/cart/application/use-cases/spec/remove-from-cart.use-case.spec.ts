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
const MAX_ATTEMPTS = 5;
// The seeded cart starts at version 2 (see `seedCartWithTwoLines`).
const SEED_VERSION = 2;

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
      MAX_ATTEMPTS,
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

  describe('optimistic concurrency (ADR-036)', () => {
    it('honors a matching If-Match version and persists at the bumped version', async () => {
      const view = await useCase.execute({
        cartId: CART_ID,
        customerId: OWNER_ID,
        lineId: LINE_ID,
        expectedVersion: SEED_VERSION,
        correlationId: 'corr-ok',
      });

      expect(view.lines).toHaveLength(1);
      expect(view.version).toBe(SEED_VERSION + 1);
      expect(inventory.releaseCalls).toHaveLength(1);
    });

    it('rejects a stale If-Match with 409 VERSION_MISMATCH and does NOT retry, save, or release', async () => {
      await expect(
        useCase.execute({
          cartId: CART_ID,
          customerId: OWNER_ID,
          lineId: LINE_ID,
          expectedVersion: SEED_VERSION - 1, // stale
          correlationId: 'corr-stale',
        }),
      ).rejects.toMatchObject({
        code: CartErrorCodeEnum.CART_VERSION_MISMATCH,
        details: { currentVersion: SEED_VERSION },
      });

      expect(repository.saved).toHaveLength(0);
      expect(inventory.releaseCalls).toHaveLength(0);
      expect(publisher.lineRemoved).toHaveLength(0);
    });

    it('retries a lost race (no If-Match) and releases exactly once after the winning save', async () => {
      repository.conflictsBeforeSuccess = 1;

      const view = await useCase.execute({
        cartId: CART_ID,
        customerId: OWNER_ID,
        lineId: LINE_ID,
        correlationId: 'corr-retry',
      });

      expect(view.lines).toHaveLength(1);
      // Exactly one successful persist; the best-effort release runs once, outside
      // the retry loop, so a retried attempt never double-releases.
      expect(repository.saved).toHaveLength(1);
      expect(inventory.releaseCalls).toHaveLength(1);
      expect(publisher.lineRemoved).toHaveLength(1);
    });

    it('surfaces 409 VERSION_MISMATCH with the current version after the retry budget is exhausted', async () => {
      repository.conflictsBeforeSuccess = 99;

      await expect(
        useCase.execute({
          cartId: CART_ID,
          customerId: OWNER_ID,
          lineId: LINE_ID,
          correlationId: 'corr-exhaust',
        }),
      ).rejects.toMatchObject({
        code: CartErrorCodeEnum.CART_VERSION_MISMATCH,
        details: { currentVersion: SEED_VERSION + MAX_ATTEMPTS },
      });

      expect(repository.saved).toHaveLength(0);
      expect(inventory.releaseCalls).toHaveLength(0);
    });
  });
});
