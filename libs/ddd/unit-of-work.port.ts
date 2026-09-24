export interface IUnitOfWorkRunner<TRepositories> {
  run<T>(work: (repositories: TRepositories) => Promise<T>): Promise<T>;
}
