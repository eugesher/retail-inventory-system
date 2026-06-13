import { HttpStatus } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

import { InventoryDomainException, InventoryErrorCodeEnum } from '../../domain';
import { InventoryRpcExceptionFilter } from '../inventory-rpc-exception.filter';

// The filter is pure (no DI), so it is unit-tested directly. `catch` returns a
// `throwError` observable; `firstValueFrom` rejects with the wire payload the RMQ
// client would receive, which is exactly what the gateway's `throwRpcError` reads.
// We assert the `statusCode` the gateway keys on for every domain code.
describe('InventoryRpcExceptionFilter', () => {
  const filter = new InventoryRpcExceptionFilter();

  const statusFor = async (code: InventoryErrorCodeEnum): Promise<unknown> => {
    const exception = new InventoryDomainException(code, `message for ${code}`);
    return firstValueFrom(filter.catch(exception)).then(
      () => {
        throw new Error('filter stream resolved; expected it to error');
      },
      (payload: unknown) => payload,
    );
  };

  it('maps malformed-input invariants to 400', async () => {
    for (const code of [
      InventoryErrorCodeEnum.STOCK_RECEIVE_QUANTITY_INVALID,
      InventoryErrorCodeEnum.STOCK_ADJUSTMENT_DELTA_INVALID,
      InventoryErrorCodeEnum.STOCK_ADJUSTMENT_REASON_REQUIRED,
    ]) {
      await expect(statusFor(code)).resolves.toMatchObject({
        statusCode: HttpStatus.BAD_REQUEST,
        code,
      });
    }
  });

  it('maps a location lookup miss to 404', async () => {
    await expect(statusFor(InventoryErrorCodeEnum.STOCK_LOCATION_NOT_FOUND)).resolves.toMatchObject(
      {
        statusCode: HttpStatus.NOT_FOUND,
        code: InventoryErrorCodeEnum.STOCK_LOCATION_NOT_FOUND,
        message: `message for ${InventoryErrorCodeEnum.STOCK_LOCATION_NOT_FOUND}`,
      },
    );
  });

  it('maps state conflicts (inactive location, below-zero result) to 409', async () => {
    for (const code of [
      InventoryErrorCodeEnum.STOCK_LOCATION_INACTIVE,
      InventoryErrorCodeEnum.STOCK_RESULT_NEGATIVE,
    ]) {
      await expect(statusFor(code)).resolves.toMatchObject({
        statusCode: HttpStatus.CONFLICT,
        code,
      });
    }
  });

  it('covers every InventoryErrorCodeEnum member (no code falls through to 500)', async () => {
    for (const code of Object.values(InventoryErrorCodeEnum)) {
      const payload = (await statusFor(code)) as { statusCode: number };
      expect(payload.statusCode).not.toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    }
  });

  it('maps OUT_OF_STOCK to 409 and forwards structured details', async () => {
    const exception = new InventoryDomainException(
      InventoryErrorCodeEnum.OUT_OF_STOCK,
      'out of stock',
      { available: 2 },
    );
    const payload = await firstValueFrom(filter.catch(exception)).then(
      () => {
        throw new Error('filter stream resolved; expected it to error');
      },
      (rejected: unknown) => rejected,
    );

    expect(payload).toMatchObject({
      statusCode: HttpStatus.CONFLICT,
      code: InventoryErrorCodeEnum.OUT_OF_STOCK,
      details: { available: 2 },
    });
  });

  it('omits the details key entirely when the exception carries none', async () => {
    const payload = (await statusFor(InventoryErrorCodeEnum.RESERVATION_NOT_FOUND)) as Record<
      string,
      unknown
    >;
    expect(payload).not.toHaveProperty('details');
  });
});
