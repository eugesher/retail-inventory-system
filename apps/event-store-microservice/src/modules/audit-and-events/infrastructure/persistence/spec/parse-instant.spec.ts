import { execFileSync } from 'child_process';
import { join } from 'path';

import { parseInstant } from '../parse-instant';

// `parseInstant` exists for exactly one reason: `new Date('2026-06-01T00:00:00')` — no `Z`, no
// `±hh:mm` — resolves in the HOST's local zone, while `new Date('2026-06-01')` resolves as UTC. It is
// an ES-spec asymmetry, not a driver one, so `DatabaseModule`'s `timezone: 'Z'` pin does not reach it,
// and `@IsISO8601()` accepts the zone-less form happily. An operator asking for "everything since
// June 1st" gets a window silently shifted by the event store host's offset, quietly including and
// excluding rows at both ends.
//
// The function had no spec. **And the obvious one would have been VACUOUS**, which is why this file is
// shaped the way it is:
//
//   On a UTC host, `new Date('2026-06-01T00:00:00')` and `new Date('2026-06-01T00:00:00Z')` are the
//   SAME INSTANT. An in-process test asserting that `parseInstant` returns the UTC instant therefore
//   passes on a UTC machine **even if the function does nothing at all** — and CI runners are UTC. It
//   would have been green forever, proving nothing, on the one function whose whole job is to be right
//   about timezones.
//
// **The zone cannot be forced from inside the test, and the attempt LOOKS like it works.** Jest
// replaces `process.env` in the sandbox with a plain object, so `process.env.TZ = 'Asia/Tokyo'` in a
// `beforeAll` sets the variable — it reads back correctly — and does not move the clock: `Intl` keeps
// reporting the host zone and `Date` keeps parsing in it. (Verified. It is a convincing no-op.)
//
// So the zone-sensitive proof runs the real function in REAL child processes, one per timezone, with
// `TZ` set before Node starts — which is the only point at which it is read. That also lets the suite
// assert the property that actually matters, and it is stronger than "correct in Tokyo":
//
//                        **the answer does not depend on where the process runs.**
//
// (`spec/architecture-lint.spec.ts` set the precedent: when the thing under test is what a tool or a
// runtime really does, shell out and read the real answer rather than model it.)
const PARSE_INSTANT = join(__dirname, '..', 'parse-instant.ts');

// Two zones on opposite sides of UTC, plus UTC itself as the degenerate case. Neither offset zone
// observes DST at these dates in a way that could drift: `Asia/Tokyo` has none at all, and the
// `America/New_York` expectation is stated for the date under test, in June (EDT, UTC−4).
const ZONES = [
  { tz: 'Asia/Tokyo', offsetHours: 9 },
  { tz: 'America/New_York', offsetHours: -4 },
  { tz: 'UTC', offsetHours: 0 },
] as const;

const ZONELESS = '2026-06-01T00:00:00';
const UTC_INSTANT = '2026-06-01T00:00:00.000Z';

// The same trap, with a fractional-seconds tail. It belongs in the CHILD probe and not in the
// in-process block below, for the same reason as the bare form: `…00.123` and `…00.123Z` are the same
// instant on a UTC host, so asserting it in-process would prove nothing on CI.
const ZONELESS_MS = '2026-06-01T00:00:00.123';
const UTC_INSTANT_MS = '2026-06-01T00:00:00.123Z';

interface IProbe {
  // What the host zone actually resolved to — the control. If a child ignored `TZ`, this says so.
  resolvedZone: string;
  // `parseInstant(ZONELESS)` — must be the same instant everywhere.
  pinned: string;
  // The same, with fractional seconds — the regex has to admit the `.` or this one silently drifts.
  pinnedMs: string;
  // `new Date(ZONELESS)` — the platform's own reading, which must NOT be.
  platform: string;
}

// Runs the real `parse-instant.ts` under a real timezone. `transpileOnly` because we are exercising
// runtime behaviour, not typechecking — the suite already compiles this file.
const probeUnderZone = (tz: string): IProbe => {
  const script = `
    const { parseInstant } = require(${JSON.stringify(PARSE_INSTANT)});
    process.stdout.write(JSON.stringify({
      resolvedZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      pinned: parseInstant(${JSON.stringify(ZONELESS)}).toISOString(),
      pinnedMs: parseInstant(${JSON.stringify(ZONELESS_MS)}).toISOString(),
      platform: new Date(${JSON.stringify(ZONELESS)}).toISOString(),
    }));
  `;

  const stdout = execFileSync(process.execPath, ['-r', 'ts-node/register', '-e', script], {
    cwd: join(__dirname, '..', '..', '..', '..', '..', '..', '..'),
    env: { ...process.env, TZ: tz, TS_NODE_TRANSPILE_ONLY: 'true' },
    encoding: 'utf8',
  });

  return JSON.parse(stdout) as IProbe;
};

describe('parseInstant — the zone-less bound, proved across real timezones', () => {
  const probes = new Map<string, IProbe>();

  beforeAll(() => {
    for (const { tz } of ZONES) {
      probes.set(tz, probeUnderZone(tz));
    }
    // One spawn per zone, hoisted here: a child process costs ~2s, and the tests only read the result.
  }, 60_000);

  // **The control.** Without it, a child that silently ignored `TZ` would make every assertion below
  // trivially true — the exact vacuum this file exists to avoid, reintroduced one level down.
  it.each(ZONES)('the child really runs in $tz (control)', ({ tz }) => {
    expect(probes.get(tz)?.resolvedZone).toBe(tz);
  });

  // The platform disagrees with itself across zones — which is precisely the bug, and the reason the
  // assertion after it is not trivial. In New York the same string is a full THIRTEEN hours away from
  // what it means in Tokyo.
  it.each(ZONES)(
    'the platform’s own parse of a zone-less string drifts in $tz',
    ({ tz, offsetHours }) => {
      const platform = new Date(probes.get(tz)!.platform).getTime();
      const utc = new Date(UTC_INSTANT).getTime();

      // A zone ahead of UTC reads local midnight as an EARLIER absolute instant, and vice versa.
      expect(utc - platform).toBe(offsetHours * 3_600_000);
    },
  );

  // **The property.** Same input, three machines, one answer.
  it.each(ZONES)('parseInstant pins the bound to UTC in $tz', ({ tz }) => {
    expect(probes.get(tz)?.pinned).toBe(UTC_INSTANT);
  });

  // The `[\d:.]+` tail of the regex is what admits this form. Narrow it to `[\d:]+` — an easy
  // "tidy-up" — and a bound with milliseconds silently stops being pinned, in the one direction nobody
  // would think to check.
  it.each(ZONES)('parseInstant pins a FRACTIONAL-seconds bound to UTC in $tz', ({ tz }) => {
    expect(probes.get(tz)?.pinnedMs).toBe(UTC_INSTANT_MS);
  });

  it('gives the identical instant in every zone — the answer does not depend on the host', () => {
    const answers = new Set(ZONES.map(({ tz }) => probes.get(tz)?.pinned));
    const answersMs = new Set(ZONES.map(({ tz }) => probes.get(tz)?.pinnedMs));

    expect(answers).toEqual(new Set([UTC_INSTANT]));
    expect(answersMs).toEqual(new Set([UTC_INSTANT_MS]));
  });
});

// The rest of the contract needs no timezone: these inputs mean the same thing on every host, so they
// run in-process.
describe('parseInstant — the bounds it must leave alone', () => {
  it('honours an explicit Z', () => {
    expect(parseInstant('2026-06-01T00:00:00Z')).toEqual(new Date(UTC_INSTANT));
  });

  // A caller who supplied an offset MEANT it. Appending a `Z` to `…+02:00` would produce nonsense, so
  // the regex requires the string to end in digits / colons / dots — an offset ends in neither.
  it('honours an explicit numeric offset instead of overriding it', () => {
    expect(parseInstant('2026-06-01T02:00:00+02:00')).toEqual(new Date(UTC_INSTANT));
  });

  it('honours a negative offset', () => {
    expect(parseInstant('2026-05-31T20:00:00-04:00')).toEqual(new Date(UTC_INSTANT));
  });

  // **The asymmetry that makes the regex necessary rather than paranoid.** A date-ONLY string is
  // ALREADY UTC per the ES spec — the exact opposite of the date-time case. It must not be touched:
  // treating the two forms alike is how you fix one bug by creating its mirror image.
  it('leaves a date-only string alone — it is already UTC', () => {
    expect(parseInstant('2026-06-01')).toEqual(new Date(UTC_INSTANT));
  });
});

describe('parseInstant — absence', () => {
  it('returns undefined for an absent bound', () => {
    expect(parseInstant(undefined)).toBeUndefined();
  });

  // An unparseable bound means "no bound", not "reject". The gateway DTO (`@IsISO8601()`) is the
  // validation gate; a malformed value can only reach here through a direct RPC, where WIDENING the
  // scan is the safe answer — a narrower one would hide rows. (The `ListStockMovementsUseCase`
  // precedent.)
  it('treats an unparseable bound as absent rather than throwing', () => {
    expect(parseInstant('not-a-date')).toBeUndefined();
    expect(parseInstant('')).toBeUndefined();
    // Well-formed shape, impossible instant — `new Date` yields `Invalid Date`, whose `getTime()` is
    // `NaN`. It must not become a bound: `NaN` compares `false` against everything, so a `Between`
    // built on it would match nothing, and the page would come back EMPTY rather than unfiltered.
    expect(parseInstant('2026-13-45T99:99:99')).toBeUndefined();
  });
});
