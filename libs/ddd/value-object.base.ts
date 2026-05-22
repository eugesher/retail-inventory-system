// Equality is structural; props must be JSON-stable (no Date / Map / cycles)
// because comparison uses JSON.stringify. Immutability is enforced via freeze.
export abstract class ValueObject<TProps extends Record<string, unknown>> {
  protected readonly props: TProps;

  protected constructor(props: TProps) {
    this.props = Object.freeze({ ...props });
  }

  public equals(other?: ValueObject<TProps>): boolean {
    if (other == null) return false;
    if (other.constructor !== this.constructor) return false;
    return JSON.stringify(this.props) === JSON.stringify(other.props);
  }
}
