export interface IIdempotentResult<TView> {
  readonly view: TView;

  readonly replayed: boolean;
}
