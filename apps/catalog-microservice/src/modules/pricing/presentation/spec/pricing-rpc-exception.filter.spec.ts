import { HttpStatus } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

import { PricingDomainException, PricingErrorCodeEnum } from '../../domain';
import { PricingRpcExceptionFilter } from '../pricing-rpc-exception.filter';

// The filter is pure (no DI), so it is unit-tested directly. `catch` returns a
// `throwError` observable; `firstValueFrom` rejects with the wire payload the RMQ
// client would receive, which is exactly what the gateway's `throwRpcError`
// reads. We assert the `statusCode` the gateway keys on for every domain code.
describe('PricingRpcExceptionFilter', () => {
  const filter = new PricingRpcExceptionFilter();

  const statusFor = async (code: PricingErrorCodeEnum): Promise<unknown> => {
    const exception = new PricingDomainException(code, `message for ${code}`);
    return firstValueFrom(filter.catch(exception)).then(
      () => {
        throw new Error('filter stream resolved; expected it to error');
      },
      (payload: unknown) => payload,
    );
  };

  it('maps the schedule conflict to 409', async () => {
    await expect(statusFor(PricingErrorCodeEnum.PRICE_SCHEDULE_CONFLICT)).resolves.toMatchObject({
      statusCode: HttpStatus.CONFLICT,
      code: PricingErrorCodeEnum.PRICE_SCHEDULE_CONFLICT,
      message: `message for ${PricingErrorCodeEnum.PRICE_SCHEDULE_CONFLICT}`,
    });
  });

  it('maps the tax-category code collision to 409', async () => {
    await expect(statusFor(PricingErrorCodeEnum.TAX_CATEGORY_CODE_TAKEN)).resolves.toMatchObject({
      statusCode: HttpStatus.CONFLICT,
    });
  });

  it('maps lookup misses to 404', async () => {
    for (const code of [
      PricingErrorCodeEnum.TAX_CATEGORY_NOT_FOUND,
      PricingErrorCodeEnum.VARIANT_NOT_FOUND,
    ]) {
      await expect(statusFor(code)).resolves.toMatchObject({
        statusCode: HttpStatus.NOT_FOUND,
        code,
      });
    }
  });

  it('maps malformed-input invariants to 400', async () => {
    for (const code of [
      PricingErrorCodeEnum.PRICE_AMOUNT_INVALID,
      PricingErrorCodeEnum.PRICE_CURRENCY_INVALID,
      PricingErrorCodeEnum.PRICE_INTERVAL_INVALID,
      PricingErrorCodeEnum.PRICE_VALID_FROM_IN_PAST,
      PricingErrorCodeEnum.PRICE_PRIORITY_INVALID,
      PricingErrorCodeEnum.TAX_CATEGORY_CODE_INVALID,
      PricingErrorCodeEnum.TAX_CATEGORY_NAME_REQUIRED,
    ]) {
      await expect(statusFor(code)).resolves.toMatchObject({
        statusCode: HttpStatus.BAD_REQUEST,
        code,
      });
    }
  });

  it('covers every PricingErrorCodeEnum member (no code falls through to 500)', async () => {
    for (const code of Object.values(PricingErrorCodeEnum)) {
      const payload = (await statusFor(code)) as { statusCode: number };
      expect(payload.statusCode).not.toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    }
  });
});
