// The register of **obligations queued behind a condition** — and the check that makes them come due
// (ADR-053).
//
// **This file exists because the rule already existed and was forgotten three times.**
// [ADR-046](../docs/adr/046-libs-layout-and-dead-export-removal.md) wrote it down in as many words —
// *"a deletion queued behind a condition, with no owner and no check, is not queued — it is
// forgotten"* — and then:
//
//   * `CacheHelper` was queued behind "the next cache-key version bump". The key went `v1 → v2 → v3`.
//     **The condition fired three times.** ADR-046 deleted it, eleven epics late.
//   * `POST /auth/login` was "a deprecated alias kept for one release" — **in the commit that
//     introduced it**. ADR-050 removed it eleven epics later.
//   * Four Redis `SCAN` passes were kept "for the rolling deploy that adopts v3". **No deploy ever
//     straddled a version.** They ran on every stock write until ISSUE-03.
//
// Three obligations. Three conditions met. **Zero acted on.** A rule that is stated and not checked is
// not a rule — it is a wish, and this repository has now paid for that lesson three times.
//
// **So the rule ships with its enforcement, or it becomes its own fourth instance.** Every entry below
// carries a `reviewBy` date, and the first test **goes red on that date**. The date is not a deadline
// for the *work*; it is a deadline for the **decision**. CI does not care whether the condition has
// fired — it cares that a human looked.
//
// **What does NOT belong here:** a *reserved surface*. An unused `CACHE_KEYS` builder or `EXCHANGES`
// member is one line in a registry where being complete is the point (ADR-046) — it is not queued
// behind anything and nobody owes anything. The distinction is whether a future event is supposed to
// make somebody act.

interface ITransitionWindow {
  // A stable handle, so a failing test names the thing rather than a line number.
  id: string;
  // The obligation. What is owed.
  what: string;
  // What is supposed to discharge it. **If you cannot state this as an event someone will notice,
  // you have not queued anything — you have hidden it.**
  condition: string;
  // A ticket or a person. "The team" is not an owner.
  owner: string;
  // ISO date. **The day CI forces the conversation**, whether or not the condition has fired. Pick a
  // date you would be embarrassed to sail past, not one that safely outlives your tenure.
  reviewBy: string;
  // The decision this obligation came out of.
  adr: string;
}

// **It has exactly one entry, and that is the healthy state.** The register starts near-empty because
// the three obligations that taught us to build it have just been paid off. It is a place to put the
// next one — not a backlog to admire.
const OPEN_WINDOWS: ITransitionWindow[] = [
  {
    id: 'capture-claim-reconciler',
    what:
      'ReportStaleCaptureClaimsUseCase REPORTS stranded `capturing` payments and resolves none of ' +
      'them. It cannot: `IPaymentGatewayPort` offers authorize/capture/refund and no way to ask ' +
      '"did my capture land?". Releasing the claim would invite a second charge; completing it would ' +
      'record money that may never have moved.',
    condition:
      'A real payment gateway is bound in place of `FakePaymentGatewayAdapter`. Every real processor ' +
      'exposes a capture-status query — the day one is bound, the reporter can become a true ' +
      'reconciler, and until then it MUST NOT guess.',
    owner: 'repository owner (no ticket yet — that is itself the finding)',
    reviewBy: '2027-01-13',
    adr: 'ADR-052',
  },
];

describe('transition windows (ADR-053)', () => {
  // **THE test.** It is the entire mechanism, and it is four lines. What was missing for eleven epics
  // was never a clever design — it was a date and something that reads it.
  it('no open window is past its reviewBy date', () => {
    const today = new Date();
    const overdue = OPEN_WINDOWS.filter((w) => new Date(w.reviewBy) <= today);

    // The failure has to be actionable at 3am, so it carries the whole entry rather than a boolean.
    // A red build that only says `expected 1 to be 0` teaches the next person to delete the test.
    expect(
      overdue.map(
        (w) =>
          `\n  [${w.id}] (${w.adr}, owner: ${w.owner}) came due on ${w.reviewBy}.` +
          `\n    OWED:      ${w.what}` +
          `\n    CLOSES ON: ${w.condition}` +
          `\n    → Discharge it, or move the date DELIBERATELY and say why in the commit. ` +
          `Deleting this entry to make CI green is the exact failure ADR-053 exists to stop.`,
      ),
    ).toEqual([]);
  });

  // A window with no owner, no condition or no ADR is not queued — it is hidden. These fields are the
  // difference between an obligation and a shrug.
  it('every window names an owner, a condition, an ADR and a review date', () => {
    for (const w of OPEN_WINDOWS) {
      expect(w.id).not.toHaveLength(0);
      expect(w.what).not.toHaveLength(0);
      expect(w.condition).not.toHaveLength(0);
      expect(w.owner).not.toHaveLength(0);
      expect(w.adr).toMatch(/^ADR-\d{3}$/);
      // A malformed date silently becomes `Invalid Date`, which compares `false` against everything —
      // so a typo here would disarm the check above **without failing anything**. Pin the shape.
      expect(w.reviewBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(new Date(w.reviewBy).getTime())).toBe(false);
    }
  });

  // A window whose review date is a decade out is a window nobody will ever look at — the same
  // forgetting, wearing a date. Two years is already generous for a condition you expect to fire.
  it('no window defers its review by more than two years', () => {
    const twoYearsOut = new Date();
    twoYearsOut.setFullYear(twoYearsOut.getFullYear() + 2);

    const tooFar = OPEN_WINDOWS.filter((w) => new Date(w.reviewBy) > twoYearsOut);
    expect(tooFar.map((w) => `${w.id} (reviewBy ${w.reviewBy})`)).toEqual([]);
  });
});
