import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';

// A cross-property class-validator constraint: this ISO-8601 instant must not precede
// the one held by `lowerBoundProperty`. class-validator ships no comparison across two
// properties of the same object, so the audit query DTOs register this one.
//
// Why the check exists at all: the event store answers an inverted `from`/`to` window
// with an EMPTY PAGE rather than a rejection — `BETWEEN hi AND lo` selects nothing in
// MySQL, and growing the event store its first `*DomainException` for one message was
// not worth it (ADR-039). Without a gateway-side guard an operator who transposed the
// two dates would get a silently empty result and conclude nothing happened. Shape
// errors belong at the HTTP edge, where every other shape error in this system lives.
//
// It passes (rather than fails) whenever the comparison is not meaningful: either bound
// absent — each is independently optional and contributes its own predicate — or either
// value unparseable, which is `@IsISO8601()`'s rejection to report, not this one's. One
// bad value must yield one error message, not two.
export function IsOnOrAfter(
  lowerBoundProperty: string,
  validationOptions?: ValidationOptions,
): (target: object, propertyName: string) => void {
  return (target: object, propertyName: string): void => {
    registerDecorator({
      name: 'isOnOrAfter',
      target: target.constructor,
      propertyName,
      constraints: [lowerBoundProperty],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          const [boundProperty] = args.constraints as [string];
          const bound = (args.object as Record<string, unknown>)[boundProperty];

          if (typeof value !== 'string' || typeof bound !== 'string') return true;

          const lower = Date.parse(bound);
          const upper = Date.parse(value);

          if (Number.isNaN(lower) || Number.isNaN(upper)) return true;

          return upper >= lower;
        },
        defaultMessage(args: ValidationArguments): string {
          const [boundProperty] = args.constraints as [string];

          return `${args.property} must be the same instant as, or after, ${boundProperty}`;
        },
      },
    });
  };
}
