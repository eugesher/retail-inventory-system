// The transaction seam, Unit-of-Work shaped (ADR-063): a use case asks the port to run
// its work against a bag of already-transaction-bound write repositories, instead of
// receiving an opaque `ITransactionScope` it must thread by hand into every repository
// call. A forgotten scope used to compile; a repository that is not on the bag cannot be
// called at all, so there is nothing to forget.
//
// It lives in `libs/ddd`, not `libs/database`, for the same reason `ITransactionPort` does
// (ADR-017/ADR-043): `application/ports` may import only `lib-ddd` and `lib-contracts`, and
// a UoW port declared in the database lib would be unreachable from the layer that exists
// to consume it.
//
// `TRepositories` is the module's OWN repository bag — e.g. `IOrdersUnitOfWork` — declared
// in that module's `application/ports/`. This file owns only the shape every module's bag
// shares: "run some work against a set of repositories, atomically." What composes the bag
// and how each repository is built from an `EntityManager` is module-specific and stays
// module-local, the same split ADR-045 uses for the OCC retry protocol (shared loop, local
// policy).
export interface IUnitOfWorkRunner<TRepositories> {
  run<T>(work: (repositories: TRepositories) => Promise<T>): Promise<T>;
}
