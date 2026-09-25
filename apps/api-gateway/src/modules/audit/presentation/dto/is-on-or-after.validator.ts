import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';

const ZONELESS_DATE_TIME = /^\d{4}-\d{2}-\d{2}T[\d:.]+$/;

const parseAsUtc = (value: string): number =>
  Date.parse(ZONELESS_DATE_TIME.test(value) ? `${value}Z` : value);

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
