import { ROUTING_KEYS } from '../routing-keys.constants';

// **These are invariants, not a snapshot.** Nothing below names an individual routing key: add
// one tomorrow and this file does not change.
//
// What it replaces was the opposite — 112 hand-written
// `expect(ROUTING_KEYS.X).toBe(MicroserviceMessagePatternEnum.X)` lines, one per member of the
// back-compat mirror enum that ADR-059 deleted. That suite could see exactly one failure mode:
// a value changed under a name present on BOTH sides. A key added to only one side was
// invisible to it, and five had been (`audit.staff.action` and the four consent / marketing
// keys) — deliberately, since the enum existed only for callers predating `ROUTING_KEYS`. So
// 112 green assertions were pinning a snapshot of 2026-06 and calling it lock-step.
describe('ROUTING_KEYS', () => {
  const entries = Object.entries(ROUTING_KEYS);

  // Guard: every loop below is vacuously green over an empty object. If the constants ever move
  // or the import resolves to `{}`, this is the test that says so.
  it('is a non-empty registry', () => {
    expect(entries.length).toBeGreaterThan(50);
  });

  // The invariant the deleted enum was standing in for. `INVENTORY_STOCK_LEVEL_GET` ⇄
  // `'inventory.stock-level.get'`: the name is the value with `.` and `-` as `_`, upper-cased.
  // It ties the two halves of every entry to each other, so a typo in EITHER half fails — and
  // it does so for keys that do not exist yet, which is what a second table could never do.
  it('derives every constant name from its wire value', () => {
    for (const [name, value] of entries) {
      expect(name).toBe(value.replace(/[.-]/g, '_').toUpperCase());
    }
  });

  // Dotted `<service>.<aggregate>.<action>` (ADR-008). Not pinned to exactly three segments:
  // `customer.erased` has two, and a rule with an exception list would be the hand-maintained
  // table this suite just stopped being.
  it('uses the dotted lower-case wire convention', () => {
    for (const [, value] of entries) {
      expect(value).toMatch(/^[a-z]+(\.[a-z-]+)+$/);
    }
  });

  // Two names on one wire key would make two logical operations indistinguishable on the bus,
  // and the consumer would answer whichever handler bound last.
  it('maps no two names onto the same wire key', () => {
    const values = entries.map(([, value]) => value);
    expect(new Set(values).size).toBe(values.length);
  });
});
