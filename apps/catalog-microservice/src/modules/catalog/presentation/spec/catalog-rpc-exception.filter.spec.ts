import { HttpStatus } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

import { CatalogDomainException, CatalogErrorCodeEnum } from '../../domain';
import { CatalogRpcExceptionFilter } from '../catalog-rpc-exception.filter';

// The filter is pure (no DI), so it is unit-tested directly. `catch` returns a
// `throwError` observable; `firstValueFrom` rejects with the wire payload the
// RMQ client would receive, which is exactly what the gateway's `throwRpcError`
// reads. We assert the `statusCode` the gateway keys on for every domain code.
describe('CatalogRpcExceptionFilter', () => {
  const filter = new CatalogRpcExceptionFilter();

  const statusFor = async (code: CatalogErrorCodeEnum): Promise<unknown> => {
    const exception = new CatalogDomainException(code, `message for ${code}`);
    return firstValueFrom(filter.catch(exception)).then(
      () => {
        throw new Error('filter stream resolved; expected it to error');
      },
      (payload: unknown) => payload,
    );
  };

  it('maps lookup misses to 404', async () => {
    await expect(statusFor(CatalogErrorCodeEnum.PRODUCT_NOT_FOUND)).resolves.toMatchObject({
      statusCode: HttpStatus.NOT_FOUND,
      code: CatalogErrorCodeEnum.PRODUCT_NOT_FOUND,
      message: `message for ${CatalogErrorCodeEnum.PRODUCT_NOT_FOUND}`,
    });
    for (const code of [
      CatalogErrorCodeEnum.VARIANT_NOT_FOUND,
      CatalogErrorCodeEnum.CATEGORY_NOT_FOUND,
      CatalogErrorCodeEnum.CATEGORY_PARENT_NOT_FOUND,
      CatalogErrorCodeEnum.MEDIA_NOT_FOUND,
      CatalogErrorCodeEnum.MEDIA_OWNER_NOT_FOUND,
    ]) {
      await expect(statusFor(code)).resolves.toMatchObject({
        statusCode: HttpStatus.NOT_FOUND,
        code,
      });
    }
  });

  it('maps uniqueness collisions and illegal transitions to 409', async () => {
    for (const code of [
      CatalogErrorCodeEnum.PRODUCT_SLUG_TAKEN,
      CatalogErrorCodeEnum.VARIANT_SKU_TAKEN,
      CatalogErrorCodeEnum.PRODUCT_INVALID_STATE_TRANSITION,
      CatalogErrorCodeEnum.PRODUCT_PUBLISH_REQUIRES_VARIANT,
      CatalogErrorCodeEnum.PRODUCT_PUBLISH_REQUIRES_PRICE,
      CatalogErrorCodeEnum.CATEGORY_SLUG_TAKEN,
      CatalogErrorCodeEnum.CATEGORY_CYCLE,
      CatalogErrorCodeEnum.CATEGORY_INVALID_STATE_TRANSITION,
      CatalogErrorCodeEnum.CATEGORY_ARCHIVED,
      CatalogErrorCodeEnum.MEDIA_INVALID_STATE_TRANSITION,
      CatalogErrorCodeEnum.MEDIA_REORDER_SET_MISMATCH,
    ]) {
      await expect(statusFor(code)).resolves.toMatchObject({
        statusCode: HttpStatus.CONFLICT,
        code,
      });
    }
  });

  it('maps malformed-input invariants to 400', async () => {
    for (const code of [
      CatalogErrorCodeEnum.PRODUCT_NAME_REQUIRED,
      CatalogErrorCodeEnum.PRODUCT_SLUG_REQUIRED,
      CatalogErrorCodeEnum.VARIANT_SKU_REQUIRED,
      CatalogErrorCodeEnum.VARIANT_OPTION_VALUES_REQUIRED,
      CatalogErrorCodeEnum.VARIANT_WEIGHT_INVALID,
      CatalogErrorCodeEnum.VARIANT_DIMENSIONS_INVALID,
      CatalogErrorCodeEnum.CATEGORY_NAME_REQUIRED,
      CatalogErrorCodeEnum.CATEGORY_SLUG_INVALID,
      CatalogErrorCodeEnum.CATEGORY_SORT_ORDER_INVALID,
      CatalogErrorCodeEnum.MEDIA_URI_REQUIRED,
      CatalogErrorCodeEnum.MEDIA_TYPE_INVALID,
      CatalogErrorCodeEnum.MEDIA_OWNER_TYPE_INVALID,
      CatalogErrorCodeEnum.MEDIA_OWNER_ID_INVALID,
      CatalogErrorCodeEnum.MEDIA_SORT_ORDER_INVALID,
    ]) {
      await expect(statusFor(code)).resolves.toMatchObject({
        statusCode: HttpStatus.BAD_REQUEST,
        code,
      });
    }
  });

  it('covers every CatalogErrorCodeEnum member (no code falls through to 500)', async () => {
    for (const code of Object.values(CatalogErrorCodeEnum)) {
      const payload = (await statusFor(code)) as { statusCode: number };
      expect(payload.statusCode).not.toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    }
  });
});
