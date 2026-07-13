// An ISO-8601 date-time carrying NO timezone designator (no trailing `Z`, no `±hh:mm`).
// `new Date('2026-06-01T00:00:00')` resolves such a string in the HOST's local zone, while a
// date-ONLY string (`2026-06-01`) resolves as UTC — an ES-spec asymmetry, not a driver one,
// so `DatabaseModule`'s `timezone: 'Z'` pin does not reach it.
const ZONELESS_DATE_TIME = /^\d{4}-\d{2}-\d{2}T[\d:.]+$/;

// The wire filter carries ISO-8601 bounds; the columns are `TIMESTAMP(3)` written and read as
// UTC. An absent OR unparseable bound means "no bound" — the gateway DTO (`@IsISO8601()`) is
// the validation gate, so a malformed value can only reach here through a direct RPC, where
// widening the scan is the safe answer (the `ListStockMovementsUseCase.parseInstant`
// precedent).
//
// `@IsISO8601()` ACCEPTS a zone-less date-time, so pin one to UTC before parsing: otherwise
// the window an operator asked for is silently shifted by the event store host's local offset,
// quietly including and excluding rows at both ends.
//
// Shared by both append-only repositories in this module (ADR-042). It used to be duplicated
// verbatim in each, because they were two modules and the isolation line forbade the import.
export function parseInstant(value: string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = new Date(ZONELESS_DATE_TIME.test(value) ? `${value}Z` : value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
