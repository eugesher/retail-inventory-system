export interface IPageRequest {
  page: number;
  size: number;
}

export interface IPage<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}
