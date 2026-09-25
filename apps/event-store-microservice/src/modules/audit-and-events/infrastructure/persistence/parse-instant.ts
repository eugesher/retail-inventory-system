const ZONELESS_DATE_TIME = /^\d{4}-\d{2}-\d{2}T[\d:.]+$/;

export function parseInstant(value: string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = new Date(ZONELESS_DATE_TIME.test(value) ? `${value}Z` : value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
