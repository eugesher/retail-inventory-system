// Equality is by id within the same concrete subtype — two different
// aggregates with the same numeric id are not equal.
export abstract class Entity<TId> {
  protected readonly _id: TId;

  protected constructor(id: TId) {
    this._id = id;
  }

  public get id(): TId {
    return this._id;
  }

  public equals(other?: Entity<TId>): boolean {
    if (other == null) return false;
    if (other.constructor !== this.constructor) return false;
    return this._id === other._id;
  }
}
