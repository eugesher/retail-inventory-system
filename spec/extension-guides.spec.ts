import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..');
const EXTENSIONS_DIR = join(REPO_ROOT, 'docs', 'extensions');
const INDEX_FILE = join(EXTENSIONS_DIR, 'README.md');

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

const EXPECTED_TOTAL = 64;

const EXPECTED_PER_CLUSTER: Record<(typeof CLUSTERS)[number], number> = {
  'Product Catalog': 9,
  Inventory: 8,
  'Order Management': 10,
  'Customer & Identity': 7,
  'Returns & Refunds': 6,
  'Pricing & Promotions': 8,
  'Notifications & Events': 8,
  'Staff & Access Control': 7,
  'Physical Retail': 1,
};

const CLUSTER_DIRS: Record<(typeof CLUSTERS)[number], string> = {
  'Product Catalog': 'product-catalog',
  Inventory: 'inventory',
  'Order Management': 'order-management',
  'Customer & Identity': 'customer-and-identity',
  'Returns & Refunds': 'returns-and-refunds',
  'Pricing & Promotions': 'pricing-and-promotions',
  'Notifications & Events': 'notifications-and-events',
  'Staff & Access Control': 'staff-and-access-control',
  'Physical Retail': 'physical-retail',
};

const EFFORTS = ['1 capability', '2–3 capabilities', 'subsystem-scale (5+ capabilities)'] as const;

const SECTIONS = [
  '## Description',
  '## Business needs',
  '## Attachment points in the current core',
  '## Implementation sketch',
  '## Open design questions',
  '## Effort sketch',
] as const;

const SCRATCH_PREFIX = 'tm' + 'p/';
const PLANNING_WORDS = ['ep' + 'ic', 'ta' + 'sk'];

interface IGuide {
  name: string;
  body: string;
  frontMatter: Record<string, string>;
  attachesTo: string[];
  hasFrontMatter: boolean;
}

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
  ? readdirSync(EXTENSIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .flatMap((dir) =>
        readdirSync(join(EXTENSIONS_DIR, dir.name))
          .filter((f) => f.endsWith('.md') && f !== 'README.md')
          .map((f) => `${dir.name}/${f}`),
      )
      .sort()
  : [];

const guides = guideNames.map(parseGuide);

describe('extension guides (ADR-055)', () => {
  it('the folder and its index exist', () => {
    expect(existsSync(EXTENSIONS_DIR)).toBe(true);
    expect(existsSync(INDEX_FILE)).toBe(true);
  });

  it('holds exactly the guides the index is built around', () => {
    const violations: string[] = [];

    if (guideNames.length !== EXPECTED_TOTAL) {
      violations.push(
        `docs/extensions/ holds ${guideNames.length} guides, expected ${EXPECTED_TOTAL}. ` +
          `A guide was added or deleted. Update EXPECTED_TOTAL and EXPECTED_PER_CLUSTER here AND ` +
          `the matching cluster table in README.md in the same change — the point of this ` +
          `assertion is that the two cannot drift apart quietly.`,
      );
    }

    expect(violations).toEqual([]);
  });

  it('every cluster holds the number of guides it is expected to', () => {
    const actual = new Map<string, number>(CLUSTERS.map((c) => [c, 0]));
    for (const guide of guides) {
      const cluster = guide.frontMatter.cluster;
      if (cluster && actual.has(cluster)) actual.set(cluster, (actual.get(cluster) ?? 0) + 1);
    }

    const violations = CLUSTERS.filter((c) => actual.get(c) !== EXPECTED_PER_CLUSTER[c]).map(
      (c) =>
        `cluster '${c}' holds ${actual.get(c)} guides, expected ${EXPECTED_PER_CLUSTER[c]}. ` +
        `Either a guide moved cluster (check its front matter against the index table it is ` +
        `listed under) or one was added or removed.`,
    );

    expect(violations).toEqual([]);
  });

  it('every guide sits in the directory its cluster names', () => {
    const violations: string[] = [];

    for (const guide of guides) {
      const cluster = guide.frontMatter.cluster as (typeof CLUSTERS)[number] | undefined;
      if (!cluster || !CLUSTERS.includes(cluster)) continue;

      const expectedDir = CLUSTER_DIRS[cluster];
      const actualDir = guide.name.split('/')[0];
      if (actualDir !== expectedDir) {
        violations.push(
          `${guide.name}: front matter says cluster '${cluster}', which lives in ` +
            `'${expectedDir}/', but the file is in '${actualDir}/'. Move the file or fix the ` +
            `front matter — and whichever you change, its index row moves to the matching table.`,
        );
      }
    }

    expect(violations).toEqual([]);
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
    const linkedGuides = relativeLinksIn(indexBody).filter(
      (t) => t.endsWith('.md') && !t.startsWith('.') && t.split('/').length === 2,
    );

    it('links every guide that exists, exactly once', () => {
      const counts = new Map<string, number>();
      for (const link of linkedGuides) counts.set(link, (counts.get(link) ?? 0) + 1);

      const orphans = guideNames.filter((n) => !counts.has(n));
      const duplicates = [...counts.entries()]
        .filter(([, n]) => n > 1)
        .map(([n, c]) => `${n} (${c}×)`);

      expect({ orphans, duplicates }).toEqual({ orphans: [], duplicates: [] });
    });

    it('links exactly as many files as the folder holds', () => {
      const unique = new Set(linkedGuides);
      const violations: string[] = [];

      if (unique.size !== EXPECTED_TOTAL) {
        violations.push(
          `README.md links ${unique.size} distinct guides, expected ${EXPECTED_TOTAL}. ` +
            `A guide was authored without an index row, or a row was removed without its guide.`,
        );
      }

      expect(violations).toEqual([]);
    });

    it('has no link pointing at a file that does not exist', () => {
      const dead = relativeLinksIn(indexBody).filter(
        (t) => !existsSync(resolve(EXTENSIONS_DIR, t)),
      );
      expect(dead).toEqual([]);
    });
  });
});
