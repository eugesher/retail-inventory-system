import { execFileSync } from 'child_process';
import { join } from 'path';

import { parseInstant } from '../parse-instant';

const PARSE_INSTANT = join(__dirname, '..', 'parse-instant.ts');

const ZONES = [
  { tz: 'Asia/Tokyo', offsetHours: 9 },
  { tz: 'America/New_York', offsetHours: -4 },
  { tz: 'UTC', offsetHours: 0 },
] as const;

const ZONELESS = '2026-06-01T00:00:00';
const UTC_INSTANT = '2026-06-01T00:00:00.000Z';

const ZONELESS_MS = '2026-06-01T00:00:00.123';
const UTC_INSTANT_MS = '2026-06-01T00:00:00.123Z';

interface IProbe {
  resolvedZone: string;
  pinned: string;
  pinnedMs: string;
  platform: string;
}

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
  }, 60_000);

  it.each(ZONES)('the child really runs in $tz (control)', ({ tz }) => {
    expect(probes.get(tz)?.resolvedZone).toBe(tz);
  });

  it.each(ZONES)(
    'the platform’s own parse of a zone-less string drifts in $tz',
    ({ tz, offsetHours }) => {
      const platform = new Date(probes.get(tz)!.platform).getTime();
      const utc = new Date(UTC_INSTANT).getTime();

      expect(utc - platform).toBe(offsetHours * 3_600_000);
    },
  );

  it.each(ZONES)('parseInstant pins the bound to UTC in $tz', ({ tz }) => {
    expect(probes.get(tz)?.pinned).toBe(UTC_INSTANT);
  });

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

describe('parseInstant — the bounds it must leave alone', () => {
  it('honours an explicit Z', () => {
    expect(parseInstant('2026-06-01T00:00:00Z')).toEqual(new Date(UTC_INSTANT));
  });

  it('honours an explicit numeric offset instead of overriding it', () => {
    expect(parseInstant('2026-06-01T02:00:00+02:00')).toEqual(new Date(UTC_INSTANT));
  });

  it('honours a negative offset', () => {
    expect(parseInstant('2026-05-31T20:00:00-04:00')).toEqual(new Date(UTC_INSTANT));
  });

  it('leaves a date-only string alone — it is already UTC', () => {
    expect(parseInstant('2026-06-01')).toEqual(new Date(UTC_INSTANT));
  });
});

describe('parseInstant — absence', () => {
  it('returns undefined for an absent bound', () => {
    expect(parseInstant(undefined)).toBeUndefined();
  });

  it('treats an unparseable bound as absent rather than throwing', () => {
    expect(parseInstant('not-a-date')).toBeUndefined();
    expect(parseInstant('')).toBeUndefined();
    expect(parseInstant('2026-13-45T99:99:99')).toBeUndefined();
  });
});
