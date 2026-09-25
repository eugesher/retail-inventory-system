import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const ROOT = path.resolve(__dirname, '..');

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const JS_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs']);
const HASH_EXTENSIONS = new Set(['.yml', '.yaml', '.sh', '.env', '.toml', '.py']);
const HASH_BASENAMES = new Set(['.gitignore', '.dockerignore', '.env.example']);
const EXCLUDED = /^\.yarn\/|(^|\/)(node_modules|dist)\//;

type FileKind = 'code' | 'sql' | 'hash' | 'http';

interface IComment {
  text: string;
  body: string;
  block: boolean;
  jsdoc: boolean;
  line: number;
}

interface IDirective {
  name: string;
  matches: (comment: IComment, file: string) => boolean;
}

interface IFinding {
  line: number;
  text: string;
}

const DIRECTIVES: IDirective[] = [
  {
    name: 'eslint-disable… / eslint-enable',
    matches: ({ body }) => /^eslint-(disable|enable)\b/.test(body),
  },
  { name: '/* global … */', matches: ({ body, block }) => block && /^globals?\s/.test(body) },
  {
    name: '@ts-expect-error / @ts-ignore / @ts-nocheck / @ts-check',
    matches: ({ body }) => /^@ts-(expect-error|ignore|nocheck|check)\b/.test(body),
  },
  { name: 'prettier-ignore', matches: ({ body }) => /^prettier-ignore\b/.test(body) },
  {
    name: 'istanbul ignore / c8 ignore',
    matches: ({ body }) => /^(istanbul|c8)\s+ignore\b/.test(body),
  },
  {
    name: 'webpack magic comment',
    matches: ({ body, block }) => block && /\bwebpack[A-Z]\w*\s*:/.test(body),
  },
  {
    name: '/// <reference … />',
    matches: ({ text }) => /^\/\/\/\s*<(reference|amd-module|amd-dependency)\b/.test(text),
  },
  {
    name: 'JSDoc type annotation in a .js/.mjs/.cjs file',
    matches: ({ body, jsdoc }, file) =>
      jsdoc && JS_EXTENSIONS.has(path.extname(file)) && /^@(type|typedef|satisfies)\b/.test(body),
  },
];

function kindOf(file: string): FileKind | undefined {
  const extension = path.extname(file);
  const basename = path.basename(file);
  if (CODE_EXTENSIONS.has(extension)) return 'code';
  if (extension === '.sql') return 'sql';
  if (extension === '.http') return 'http';
  if (
    HASH_EXTENSIONS.has(extension) ||
    HASH_BASENAMES.has(basename) ||
    basename.startsWith('Dockerfile') ||
    file.startsWith('.husky/')
  ) {
    return 'hash';
  }
  return undefined;
}

function scriptKindOf(file: string): ts.ScriptKind {
  switch (path.extname(file)) {
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.tsx':
      return ts.ScriptKind.TSX;
    default:
      return ts.ScriptKind.TS;
  }
}

function bodyOf(text: string): string {
  if (text.startsWith('//')) return text.replace(/^\/\/\/?/, '').trim();
  return text
    .replace(/^\/\*\*?/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*?\s?/, ''))
    .join('\n')
    .trim();
}

function commentsOf(file: string, text: string): IComment[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  const ranges = new Map<number, ts.CommentRange>();
  const visit = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode)
      return;
    const children = node.kind === ts.SyntaxKind.EndOfFileToken ? [] : node.getChildren(source);
    if (children.length > 0) {
      children.forEach(visit);
      return;
    }
    const around = [
      ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
    ];
    for (const range of around) ranges.set(range.pos, range);
  };
  visit(source);

  return [...ranges.values()]
    .sort((a, b) => a.pos - b.pos)
    .map((range) => {
      const commentText = text.slice(range.pos, range.end);
      const block = range.kind === ts.SyntaxKind.MultiLineCommentTrivia;
      return {
        text: commentText,
        body: bodyOf(commentText),
        block,
        jsdoc: block && commentText.startsWith('/**') && !commentText.startsWith('/**/'),
        line: source.getLineAndCharacterOfPosition(range.pos).line + 1,
      };
    });
}

function codeFindings(file: string, text: string): IFinding[] {
  return commentsOf(file, text)
    .filter((comment) => !DIRECTIVES.some((directive) => directive.matches(comment, file)))
    .map(({ line, text: commentText }) => ({ line, text: commentText }));
}

function sqlFindings(text: string): IFinding[] {
  const findings: IFinding[] = [];
  let line = 1;
  let i = 0;
  const lineEnd = (from: number): number => {
    const end = text.indexOf('\n', from);
    return end === -1 ? text.length : end;
  };
  while (i < text.length) {
    const char = text[i];
    if (char === '\n') {
      line++;
      i++;
    } else if (char === "'" || char === '"' || char === '`') {
      i++;
      while (i < text.length && text[i] !== char) {
        if (text[i] === '\\') i++;
        if (text[i] === '\n') line++;
        i++;
      }
      i++;
    } else if (char === '#' || (char === '-' && text[i + 1] === '-')) {
      const end = lineEnd(i);
      findings.push({ line, text: text.slice(i, end) });
      i = end;
    } else if (char === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const end = close === -1 ? text.length : close + 2;
      findings.push({ line, text: text.slice(i, end) });
      line += (text.slice(i, end).match(/\n/g) ?? []).length;
      i = end;
    } else {
      i++;
    }
  }
  return findings;
}

function hashFindings(text: string): IFinding[] {
  return text.split('\n').flatMap((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('#')) return [];
    if (index === 0 && trimmed.startsWith('#!')) return [];
    return [{ line: index + 1, text: trimmed }];
  });
}

function httpFindings(text: string): IFinding[] {
  return text.split('\n').flatMap((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('#') && !trimmed.startsWith('//')) return [];
    if (/^###\s*$/.test(trimmed) || /^(#|\/\/)\s*@\S/.test(trimmed)) return [];
    return [{ line: index + 1, text: trimmed }];
  });
}

function findingsOf(file: string, text: string): IFinding[] {
  switch (kindOf(file)) {
    case 'code':
      return codeFindings(file, text);
    case 'sql':
      return sqlFindings(text);
    case 'hash':
      return hashFindings(text);
    case 'http':
      return httpFindings(text);
    default:
      return [];
  }
}

function listFiles(): string[] {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return [...new Set(output.split('\0'))]
    .filter((file) => file !== '' && !EXCLUDED.test(file) && fs.existsSync(path.join(ROOT, file)))
    .sort();
}

function report(files: string[]): string[] {
  return files.flatMap((file) =>
    findingsOf(file, fs.readFileSync(path.join(ROOT, file), 'utf8')).map(
      ({ line, text }) =>
        `\n  ${file}:${line}  ${text.split('\n')[0].slice(0, 100)}` +
        '\n    Delete it. If it said something the code does not, write that in docs/reference/ or an ADR' +
        ' (ADR-064). Do not allowlist it and do not add a directive to hide it.',
    ),
  );
}

const lineNumbers = (findings: IFinding[]): number[] => findings.map(({ line }) => line);

describe('code carries no comments (ADR-064)', () => {
  let files: string[];

  beforeAll(() => {
    files = listFiles();
  });

  describe('the detector can fail', () => {
    it('reports every prose comment in TypeScript and keeps every functional directive', () => {
      const source = [
        '#!/usr/bin/env node',
        "const url = 'http://example.com/*not-a-comment*/';",
        'const pattern = /\\/\\/ not a comment/;',
        'const template = `// still a string ${url}`;',
        '// a prose line',
        '/* a prose block */',
        '/** a JSDoc block */',
        'const answer = 42; // a trailing note',
        '// eslint-disable-next-line no-console',
        '/* eslint-disable */',
        '/* global window */',
        '// @ts-expect-error -- the reason stays with the directive',
        '// prettier-ignore',
        '/* istanbul ignore next */',
        '/* c8 ignore next */',
        "void import(/* webpackChunkName: 'chunk' */ './chunk');",
        '/// <reference types="node" />',
        '/** @type {string} */',
      ].join('\n');

      expect(lineNumbers(findingsOf('fixture.ts', source))).toEqual([5, 6, 7, 8, 18]);
      expect(lineNumbers(findingsOf('fixture.mjs', source))).toEqual([5, 6, 7, 8]);
    });

    it('reports SQL comments outside quotes and nothing inside them', () => {
      const source = [
        "INSERT INTO t (a, b) VALUES ('Order #1 -- not a comment', 'it''s /* data */');",
        '-- a line comment',
        'SELECT 1; # a hash comment',
        '/* a block',
        '   comment */ SELECT `odd--name`, "#also data";',
        "SELECT 'escaped \\' -- still data';",
      ].join('\n');

      expect(lineNumbers(findingsOf('fixture.sql', source))).toEqual([2, 3, 4]);
    });

    it('reports whole-line # comments, keeps a first-line shebang, and keeps .http separators and directives', () => {
      const shell = [
        '#!/usr/bin/env bash',
        '# a comment',
        '  # an indented comment',
        "echo '#data'",
      ].join('\n');
      const http = [
        '###',
        '# @name login',
        '// @no-log',
        '# prose',
        '// prose',
        '#### a heading',
        'GET /x',
      ].join('\n');

      expect(lineNumbers(findingsOf('fixture.sh', shell))).toEqual([2, 3]);
      expect(lineNumbers(findingsOf('Dockerfile', shell))).toEqual([2, 3]);
      expect(lineNumbers(findingsOf('fixture.http', http))).toEqual([4, 5, 6]);
    });

    it('ignores what it does not scan: Markdown and JSON', () => {
      expect(findingsOf('README.md', '# A heading\n// a line')).toEqual([]);
      expect(findingsOf('package.json', '{ "a": "// b" }')).toEqual([]);
    });
  });

  it('scans the whole working tree, vendored Yarn excluded', () => {
    expect(files.filter((file) => kindOf(file) === 'code').length).toBeGreaterThan(1000);
    expect(files).toContain('spec/no-code-comments.spec.ts');
    expect(files.some((file) => file.startsWith('.yarn/'))).toBe(false);
  });

  it('no TypeScript or JavaScript file carries a comment other than a functional directive', () => {
    expect(report(files.filter((file) => kindOf(file) === 'code'))).toEqual([]);
  });

  it('no SQL file carries a comment', () => {
    expect(report(files.filter((file) => kindOf(file) === 'sql'))).toEqual([]);
  });

  it('no Dockerfile, YAML, shell, env, ignore, TOML, Python or request-collection file carries a whole-line comment', () => {
    expect(
      report(files.filter((file) => kindOf(file) === 'hash' || kindOf(file) === 'http')),
    ).toEqual([]);
  });
});
