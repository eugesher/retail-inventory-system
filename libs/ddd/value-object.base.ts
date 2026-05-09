// Framework-free value-object base. Equality is by structural value, not by
// reference. Subclasses pass their props to the constructor; immutability is
// enforced via `Object.freeze` so mutation through references is impossible.
export abstract class ValueObject<TProps extends Record<string, unknown>> {
  protected readonly props: TProps;

  protected constructor(props: TProps) {
    this.props = Object.freeze({ ...props });
  }

  public equals(other?: ValueObject<TProps>): boolean {
    if (other === undefined || other === null) return false;
    if (other.constructor !== this.constructor) return false;
    return JSON.stringify(this.props) === JSON.stringify(other.props);
  }
}
