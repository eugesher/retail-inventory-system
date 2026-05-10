// Framework-free domain entity. Identity is by `id`; equality compares ids
// of the same concrete subtype. The id type is generic so repositories
// using auto-increment integers (the project default per ADR-005) and
// future repositories using UUIDs can both fit.
export abstract class Entity<TId> {
  protected readonly _id: TId;

  protected constructor(id: TId) {
    this._id = id;
  }

  public get id(): TId {
    return this._id;
  }

  public equals(other?: Entity<TId>): boolean {
    if (other === undefined || other === null) return false;
    if (other.constructor !== this.constructor) return false;
    return this._id === other._id;
  }
}
