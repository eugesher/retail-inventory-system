import { IPageRequest } from './page.types';

export interface IClampPageWindowOptions {
  defaultPage?: number;
  defaultSize?: number;
  maxSize?: number;
}

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
