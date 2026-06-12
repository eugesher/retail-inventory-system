import { MediaAssetTypeEnum, MediaOwnerTypeEnum } from '@retail-inventory-system/contracts';

import { CatalogDomainException, CatalogErrorCodeEnum, MediaAsset, MediaAssetStatusEnum } from '..';

// A valid `create` input — specs override one field at a time to exercise an
// invariant.
const validInput = (
  overrides: Partial<Parameters<typeof MediaAsset.create>[0]> = {},
): Parameters<typeof MediaAsset.create>[0] => ({
  ownerType: MediaOwnerTypeEnum.PRODUCT,
  ownerId: 42,
  uri: 'https://cdn.example.com/img/phone.jpg',
  type: MediaAssetTypeEnum.IMAGE,
  sortOrder: 0,
  ...overrides,
});

// Asserts the thrown error is a CatalogDomainException carrying the EXACT code,
// never matching on the (free-text) message.
const expectCode = (fn: () => unknown, code: CatalogErrorCodeEnum): void => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CatalogDomainException);
    expect((err as CatalogDomainException).code).toBe(code);
    return;
  }
  throw new Error(`expected a CatalogDomainException(${code}) but nothing was thrown`);
};

describe('MediaAsset', () => {
  describe('create', () => {
    it('builds an active asset at the given slot with a null id and no events', () => {
      const asset = MediaAsset.create(validInput({ sortOrder: 3, altText: 'A phone' }));

      expect(asset.id).toBeNull();
      expect(asset.ownerType).toBe(MediaOwnerTypeEnum.PRODUCT);
      expect(asset.ownerId).toBe(42);
      expect(asset.uri).toBe('https://cdn.example.com/img/phone.jpg');
      expect(asset.type).toBe(MediaAssetTypeEnum.IMAGE);
      expect(asset.altText).toBe('A phone');
      expect(asset.sortOrder).toBe(3);
      expect(asset.status).toBe(MediaAssetStatusEnum.ACTIVE);
      expect(asset.pullDomainEvents()).toHaveLength(0);
    });

    it('defaults a missing altText to null', () => {
      expect(MediaAsset.create(validInput()).altText).toBeNull();
    });

    it('accepts an opaque s3:// uri (no scheme allow-list)', () => {
      expect(() =>
        MediaAsset.create(validInput({ uri: 's3://bucket/key/manual.pdf' })),
      ).not.toThrow();
    });
  });

  describe('invariants', () => {
    it.each(['', '   '])('rejects a blank uri %p with MEDIA_URI_REQUIRED', (uri) => {
      expectCode(
        () => MediaAsset.create(validInput({ uri })),
        CatalogErrorCodeEnum.MEDIA_URI_REQUIRED,
      );
    });

    it('rejects an ownerType outside the enum with MEDIA_OWNER_TYPE_INVALID', () => {
      expectCode(
        () => MediaAsset.create(validInput({ ownerType: 'category' as MediaOwnerTypeEnum })),
        CatalogErrorCodeEnum.MEDIA_OWNER_TYPE_INVALID,
      );
    });

    it('rejects a type outside the enum with MEDIA_TYPE_INVALID', () => {
      expectCode(
        () => MediaAsset.create(validInput({ type: 'audio' as MediaAssetTypeEnum })),
        CatalogErrorCodeEnum.MEDIA_TYPE_INVALID,
      );
    });

    it.each([0, -1, 1.5, Number.NaN])(
      'rejects a non-positive/non-integer ownerId %p with MEDIA_OWNER_ID_INVALID',
      (ownerId) => {
        expectCode(
          () => MediaAsset.create(validInput({ ownerId })),
          CatalogErrorCodeEnum.MEDIA_OWNER_ID_INVALID,
        );
      },
    );

    it.each([-1, 1.5, Number.NaN])(
      'rejects a negative/non-integer sortOrder %p with MEDIA_SORT_ORDER_INVALID',
      (sortOrder) => {
        expectCode(
          () => MediaAsset.create(validInput({ sortOrder })),
          CatalogErrorCodeEnum.MEDIA_SORT_ORDER_INVALID,
        );
      },
    );
  });

  describe('archive — active → archived (detach)', () => {
    it('flips an active asset to archived', () => {
      const asset = MediaAsset.create(validInput());

      asset.archive();

      expect(asset.status).toBe(MediaAssetStatusEnum.ARCHIVED);
      expect(asset.isArchived()).toBe(true);
    });

    it('rejects archiving an already-archived asset (state-guarded, not idempotent)', () => {
      const asset = MediaAsset.create(validInput());
      asset.archive();

      expectCode(() => asset.archive(), CatalogErrorCodeEnum.MEDIA_INVALID_STATE_TRANSITION);
    });
  });
});
