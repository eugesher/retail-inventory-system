import { Catch, HttpStatus, RpcExceptionFilter } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';

import { CatalogDomainException, CatalogErrorCodeEnum } from '../domain';

const CATALOG_ERROR_STATUS: Record<CatalogErrorCodeEnum, HttpStatus> = {
  [CatalogErrorCodeEnum.PRODUCT_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [CatalogErrorCodeEnum.VARIANT_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [CatalogErrorCodeEnum.CATEGORY_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [CatalogErrorCodeEnum.CATEGORY_PARENT_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [CatalogErrorCodeEnum.MEDIA_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [CatalogErrorCodeEnum.MEDIA_OWNER_NOT_FOUND]: HttpStatus.NOT_FOUND,

  [CatalogErrorCodeEnum.PRODUCT_SLUG_TAKEN]: HttpStatus.CONFLICT,
  [CatalogErrorCodeEnum.VARIANT_SKU_TAKEN]: HttpStatus.CONFLICT,
  [CatalogErrorCodeEnum.PRODUCT_INVALID_STATE_TRANSITION]: HttpStatus.CONFLICT,
  [CatalogErrorCodeEnum.PRODUCT_PUBLISH_REQUIRES_VARIANT]: HttpStatus.CONFLICT,
  [CatalogErrorCodeEnum.PRODUCT_PUBLISH_REQUIRES_PRICE]: HttpStatus.CONFLICT,

  [CatalogErrorCodeEnum.CATEGORY_SLUG_TAKEN]: HttpStatus.CONFLICT,
  [CatalogErrorCodeEnum.CATEGORY_CYCLE]: HttpStatus.CONFLICT,
  [CatalogErrorCodeEnum.CATEGORY_INVALID_STATE_TRANSITION]: HttpStatus.CONFLICT,
  [CatalogErrorCodeEnum.CATEGORY_ARCHIVED]: HttpStatus.CONFLICT,

  [CatalogErrorCodeEnum.MEDIA_INVALID_STATE_TRANSITION]: HttpStatus.CONFLICT,
  [CatalogErrorCodeEnum.MEDIA_REORDER_SET_MISMATCH]: HttpStatus.CONFLICT,

  [CatalogErrorCodeEnum.PRODUCT_NAME_REQUIRED]: HttpStatus.BAD_REQUEST,
  [CatalogErrorCodeEnum.PRODUCT_SLUG_REQUIRED]: HttpStatus.BAD_REQUEST,
  [CatalogErrorCodeEnum.VARIANT_SKU_REQUIRED]: HttpStatus.BAD_REQUEST,
  [CatalogErrorCodeEnum.VARIANT_OPTION_VALUES_REQUIRED]: HttpStatus.BAD_REQUEST,
  [CatalogErrorCodeEnum.VARIANT_WEIGHT_INVALID]: HttpStatus.BAD_REQUEST,
  [CatalogErrorCodeEnum.VARIANT_DIMENSIONS_INVALID]: HttpStatus.BAD_REQUEST,
  [CatalogErrorCodeEnum.CATEGORY_NAME_REQUIRED]: HttpStatus.BAD_REQUEST,
  [CatalogErrorCodeEnum.CATEGORY_SLUG_INVALID]: HttpStatus.BAD_REQUEST,
  [CatalogErrorCodeEnum.CATEGORY_SORT_ORDER_INVALID]: HttpStatus.BAD_REQUEST,
  [CatalogErrorCodeEnum.MEDIA_URI_REQUIRED]: HttpStatus.BAD_REQUEST,
  [CatalogErrorCodeEnum.MEDIA_TYPE_INVALID]: HttpStatus.BAD_REQUEST,
  [CatalogErrorCodeEnum.MEDIA_OWNER_TYPE_INVALID]: HttpStatus.BAD_REQUEST,
  [CatalogErrorCodeEnum.MEDIA_OWNER_ID_INVALID]: HttpStatus.BAD_REQUEST,
  [CatalogErrorCodeEnum.MEDIA_SORT_ORDER_INVALID]: HttpStatus.BAD_REQUEST,
};

@Catch(CatalogDomainException)
export class CatalogRpcExceptionFilter implements RpcExceptionFilter<CatalogDomainException> {
  public catch(exception: CatalogDomainException): Observable<never> {
    const statusCode = CATALOG_ERROR_STATUS[exception.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;

    return throwError(() => ({
      statusCode,
      message: exception.message,
      code: exception.code,
    }));
  }
}
