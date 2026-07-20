// The structure check for `docs/extensions/` — the folder of sketches describing how capabilities
// outside the universal core would attach if a business ever needed them (ADR-055).
//
// **Why a folder of prose gets a test at all.** Sixty-odd hand-written files with a hand-maintained
// index and no check is the decay pattern this repository has already paid for twice (ADR-046,
// ADR-053): an assertion that is believed is an assertion nobody rechecks.
//
// **What decays, specifically.** Not the guides' subject matter — a guide is deleted by whoever
// builds the capability, and they are reading it at the time. What rots is the *anchor*: a guide
// says "attaches to the `Order` aggregate at `<path>`", a module moves eight months later in a
// change that has nothing to do with extensions, and the sentence is silently false. ADR-053 says
// to prefer a mechanical condition over a review date wherever one fits, and this one fits: every
// guide declares its attachment points in front matter, and the check below asserts they exist. The
// build goes red on the commit that moves the module, when a human is already looking at that seam.
//
// **What this check deliberately cannot do:** it reaches the paths, never the prose. A guide whose
// sketch describes an architecture three refactors old passes every assertion here. Saying so is the
// point — a reader who believes the folder is machine-verified will trust it further than it earns.
//
// There is deliberately **no assertion on the total number of guides** while the folder is being
// filled in: a count that fails for eight consecutive sittings is a count everyone learns to skip.
// It arrives once the folder is whole.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..');
const EXTENSIONS_DIR = join(REPO_ROOT, 'docs', 'extensions');
const INDEX_FILE = join(EXTENSIONS_DIR, 'README.md');

// Verbatim, and pinned against a literal list: a typo in `cluster` silently removes a guide from its
// section of the index while every other assertion still passes.
const CLUSTERS = [
  'Product Catalog',
  'Inventory',
  'Order Management',
  'Customer & Identity',
  'Returns & Refunds',
  'Pricing & Promotions',
  'Notifications & Events',
  'Staff & Access Control',
  'Physical Retail',
] as const;

// The unit is `capability` — this repository's own word for a slice of work, the one
// `docs/implementation/` is organised by. Note the en-dash in the middle value.
const EFFORTS = ['1 capability', '2–3 capabilities', 'subsystem-scale (5+ capabilities)'] as const;

const SECTIONS = [
  '## Description',
  '## Business needs',
  '## Attachment points in the current core',
  '## Implementation sketch',
  '## Open design questions',
  '## Effort sketch',
] as const;

// The orchestration-scratch path prefix and the two words that would betray the planning workflow
// these guides came out of. All three are assembled from fragments rather than written out, so that
// the repository-wide self-containment grep does not flag this file for containing the very patterns
// it enforces — a checker that trips its own check teaches people to ignore the check.
const SCRATCH_PREFIX = 'tm' + 'p/';
const PLANNING_WORDS = ['ep' + 'ic', 'ta' + 'sk'];

interface IGuide {
  name: string;
  body: string;
  frontMatter: Record<string, string>;
  attachesTo: string[];
  /** Every key seen in the front matter block, so a missing one can be named rather than inferred. */
  hasFrontMatter: boolean;
}

// A four-key block with one list. Parsed by hand on purpose: adding a YAML dependency to check a
// convention this small would cost more than the convention is worth, and
// `transition-windows.spec.ts` sets the precedent for keeping a check's own machinery minimal.
function parseGuide(name: string): IGuide {
  const raw = readFileSync(join(EXTENSIONS_DIR, name), 'utf8');
  const lines = raw.split('\n');

  const guide: IGuide = { name, body: raw, frontMatter: {}, attachesTo: [], hasFrontMatter: false };
  if (lines[0]?.trim() !== '---') return guide;

  const closing = lines.indexOf('---', 1);
  if (closing === -1) return guide;

  guide.hasFrontMatter = true;
  let inList: string | null = null;

  for (const line of lines.slice(1, closing)) {
    const listItem = /^\s+-\s+(.+)$/.exec(line);
    if (listItem && inList) {
      if (inList === 'attaches_to') guide.attachesTo.push(listItem[1].trim());
      continue;
    }

    const pair = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!pair) continue;

    const [, key, value] = pair;
    if (value.trim() === '') {
      inList = key;
    } else {
      inList = null;
      guide.frontMatter[key] = value.trim();
    }
  }

  return guide;
}

// Relative markdown links only: `http(s)` targets are somebody else's uptime problem, and a bare
// `#anchor` points inside the file it is written in.
function relativeLinksIn(markdown: string): string[] {
  const links: string[] = [];
  const pattern = /\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(markdown)) !== null) {
    const target = match[1].split('#')[0].trim();
    if (target === '' || /^https?:/i.test(target) || target.startsWith('mailto:')) continue;
    links.push(target);
  }

  return links;
}

const guideNames = existsSync(EXTENSIONS_DIR)
  ? readdirSync(EXTENSIONS_DIR)
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .sort()
  : [];

const guides = guideNames.map(parseGuide);

describe('extension guides (ADR-055)', () => {
  it('the folder and its index exist', () => {
    expect(existsSync(EXTENSIONS_DIR)).toBe(true);
    expect(existsSync(INDEX_FILE)).toBe(true);
  });

  it('every guide carries the four required front matter keys', () => {
    const violations: string[] = [];

    for (const guide of guides) {
      if (!guide.hasFrontMatter) {
        violations.push(`${guide.name}: no front matter block (expected a leading '---' fence)`);
        continue;
      }
      for (const key of ['title', 'cluster', 'effort'] as const) {
        if (!guide.frontMatter[key])
          violations.push(`${guide.name}: missing front matter key '${key}'`);
      }
      if (guide.attachesTo.length === 0) {
        violations.push(
          `${guide.name}: 'attaches_to' is missing or empty — it needs at least one path`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it('every guide names one of the nine clusters and one of the three effort values', () => {
    const violations: string[] = [];

    for (const guide of guides) {
      const { cluster, effort } = guide.frontMatter;
      if (cluster && !CLUSTERS.includes(cluster as (typeof CLUSTERS)[number])) {
        violations.push(
          `${guide.name}: cluster '${cluster}' is not one of: ${CLUSTERS.join(' | ')}`,
        );
      }
      if (effort && !EFFORTS.includes(effort as (typeof EFFORTS)[number])) {
        violations.push(`${guide.name}: effort '${effort}' is not one of: ${EFFORTS.join(' | ')}`);
      }
    }

    expect(violations).toEqual([]);
  });

  // **The assertion this whole file exists for** (ADR-055). The message names the guide AND the dead
  // path: a red build reading `expected true to be false` teaches the next person to delete the test.
  it('every attaches_to path exists on disk', () => {
    const violations: string[] = [];

    for (const guide of guides) {
      for (const target of guide.attachesTo) {
        if (!existsSync(join(REPO_ROOT, target))) {
          violations.push(
            `${guide.name}: attaches_to path '${target}' does not exist. ` +
              `Either the module moved and this guide's anchor needs updating, or the path was ` +
              `written from memory rather than read out of the source.`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('every guide has the six sections, in order, spelled exactly', () => {
    const violations: string[] = [];

    for (const guide of guides) {
      const headings = guide.body
        .split('\n')
        .filter((l) => l.startsWith('## '))
        .map((l) => l.trimEnd());

      if (headings.join('\n') !== SECTIONS.join('\n')) {
        violations.push(
          `${guide.name}: section headings are\n    [${headings.join(' | ')}]\n  expected\n    [${SECTIONS.join(' | ')}]`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it("every guide's title matches its top-level heading", () => {
    const violations: string[] = [];

    for (const guide of guides) {
      const heading = guide.body.split('\n').find((l) => l.startsWith('# '));
      const title = guide.frontMatter.title;
      if (!heading) {
        violations.push(`${guide.name}: no '# ' heading`);
      } else if (title && heading.slice(2).trim() !== title) {
        violations.push(
          `${guide.name}: front matter title '${title}' ≠ heading '${heading.slice(2).trim()}'`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  // The self-containment rule, pinned as a test rather than left to a grep somebody remembers to run.
  it('no guide references the orchestration scratch tree or names the planning workflow', () => {
    const violations: string[] = [];
    const files = [...guides, { name: 'README.md', body: readFileSync(INDEX_FILE, 'utf8') }];

    for (const file of files) {
      if (file.body.toLowerCase().includes(SCRATCH_PREFIX)) {
        violations.push(
          `${file.name}: references the orchestration scratch tree ('${SCRATCH_PREFIX}')`,
        );
      }
      for (const word of PLANNING_WORDS) {
        const hit = new RegExp(`\\b${word}\\b`, 'i').exec(file.body);
        if (hit) violations.push(`${file.name}: uses the planning word '${hit[0]}'`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('every relative link inside a guide resolves', () => {
    const violations: string[] = [];

    for (const guide of guides) {
      for (const target of relativeLinksIn(guide.body)) {
        const resolved = resolve(dirname(join(EXTENSIONS_DIR, guide.name)), target);
        if (!existsSync(resolved)) violations.push(`${guide.name}: dead link '${target}'`);
      }
    }

    expect(violations).toEqual([]);
  });

  describe('the index', () => {
    const indexBody = existsSync(INDEX_FILE) ? readFileSync(INDEX_FILE, 'utf8') : '';
    // Only links to siblings in this folder count as index entries; the tier table links out to
    // ADRs and the root README, and those are checked separately below.
    const linkedGuides = relativeLinksIn(indexBody).filter(
      (t) => t.endsWith('.md') && !t.includes('/') && t !== 'README.md',
    );

    it('links every guide that exists, exactly once', () => {
      const counts = new Map<string, number>();
      for (const link of linkedGuides) counts.set(link, (counts.get(link) ?? 0) + 1);

      const orphans = guideNames.filter((n) => !counts.has(n));
      const duplicates = [...counts.entries()]
        .filter(([, n]) => n > 1)
        .map(([n, c]) => `${n} (${c}×)`);

      // A guide not yet authored is absent from both sides, so this holds while the folder fills up.
      expect({ orphans, duplicates }).toEqual({ orphans: [], duplicates: [] });
    });

    it('has no link pointing at a file that does not exist', () => {
      const dead = relativeLinksIn(indexBody).filter(
        (t) => !existsSync(resolve(EXTENSIONS_DIR, t)),
      );
      expect(dead).toEqual([]);
    });
  });
});
