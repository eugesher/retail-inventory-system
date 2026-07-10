import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';

// An ISO-8601 date-time carrying NO timezone designator (no trailing `Z`, no `±hh:mm`).
// `Date.parse('2026-06-01T00:00:00')` resolves such a string in the host's LOCAL zone, while
// a date-ONLY string (`2026-06-01`) resolves as UTC. `@IsISO8601()` accepts both, so a
// `from` that names an offset and a `to` that does not would be compared across two
// different zones — rejecting a valid range, or admitting an inverted one. Pin the zone-less
// form to UTC, which is the zone the event store stores and compares `occurredAt` in.
const ZONELESS_DATE_TIME = /^\d{4}-\d{2}-\d{2}T[\d:.]+$/;

const parseAsUtc = (value: string): number =>
  Date.parse(ZONELESS_DATE_TIME.test(value) ? `${value}Z` : value);

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

          const lower = parseAsUtc(bound);
          const upper = parseAsUtc(value);

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
