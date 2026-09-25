interface ITransitionWindow {
  id: string;
  what: string;
  condition: string;
  owner: string;
  reviewBy: string;
  adr: string;
}

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
  it('no open window is past its reviewBy date', () => {
    const today = new Date();
    const overdue = OPEN_WINDOWS.filter((w) => new Date(w.reviewBy) <= today);

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

  it('every window names an owner, a condition, an ADR and a review date', () => {
    for (const w of OPEN_WINDOWS) {
      expect(w.id).not.toHaveLength(0);
      expect(w.what).not.toHaveLength(0);
      expect(w.condition).not.toHaveLength(0);
      expect(w.owner).not.toHaveLength(0);
      expect(w.adr).toMatch(/^ADR-\d{3}$/);
      expect(w.reviewBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(new Date(w.reviewBy).getTime())).toBe(false);
    }
  });

  it('no window defers its review by more than two years', () => {
    const twoYearsOut = new Date();
    twoYearsOut.setFullYear(twoYearsOut.getFullYear() + 2);

    const tooFar = OPEN_WINDOWS.filter((w) => new Date(w.reviewBy) > twoYearsOut);
    expect(tooFar.map((w) => `${w.id} (reviewBy ${w.reviewBy})`)).toEqual([]);
  });
});
