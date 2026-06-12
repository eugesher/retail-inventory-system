import { IPageRequest } from './page.types';

export interface IClampPageWindowOptions {
  defaultPage?: number;
  defaultSize?: number;
  maxSize?: number;
}

// Normalizes an untrusted `(page, size)` pair into a safe window. The wire/RPC
// contracts type page/size as plain numbers, so a directly-reachable handler can
// receive zero, a negative, a fraction, or an oversized page size.
//
// Floor BEFORE the positivity guard: a fractional page in (0, 1) passes a naive
// `> 0` check but floors to 0, which a `skip((page - 1) * size)` repository turns
// into a NEGATIVE offset. Flooring first collapses it to `defaultPage`. `size` is
// floored, defaulted, then capped at `maxSize` so an oversized request can never
// ask the DB for an unbounded result set.
export function clampPageWindow(
  page: number | undefined,
  size: number | undefined,
  opts: IClampPageWindowOptions = {},
): IPageRequest {
  const { defaultPage = 1, defaultSize = 20, maxSize = 100 } = opts;

  const flooredPage = Math.floor(page ?? 0);
  const flooredSize = Math.floor(size ?? 0);

  return {
    page: flooredPage > 0 ? flooredPage : defaultPage,
    size: flooredSize > 0 ? Math.min(flooredSize, maxSize) : defaultSize,
  };
}
