// Every method on an `application/ports/` interface has a PRODUCTION caller — the result ADR-049
// reached by hand, turned into a check that goes red.
//
// **ADR-049 left this open in as many words:** *"Nothing enforces this. A port method with no caller
// is not a lint error and cannot easily become one — `boundaries` reasons about imports, not about
// call graphs. The check is a script, run when someone thinks to run it, which is precisely how the
// eight accumulated."* The script was never committed. This file is that script, with the one
// property a script lacks: it runs on every `yarn test:unit` whether anyone thinks of it or not.
//
// **Why it is not an ESLint rule.** ESLint's unit of work is one file: a rule sees one AST, results
// are cached per file, and an editor relints only the file that changed. "Nothing calls this method"
// is a property of the WHOLE program — deleting the last call in file B changes the verdict for the
// port in file A, and file A is never relinted. `boundaries` can police an import because an import
// is visible in the importing file; the absence of a caller is visible in no file at all. The
// dead-export tools (`ts-prune`, `knip`) answer a different question — an unused *export* — and a
// port interface is always exported and always used; it is its *members* that go dead.
//
// **What counts as a caller**, and each rule is a way the eight looked alive while being dead:
//
//   * a property access `x.method` on anything but a bare `this` — so a use case's
//     `this.repository.save(...)` counts, and an adapter calling ITS OWN implementation
//     (`this.get(...)` inside `StockCache`, `getOrLoad`'s caller of `get`/`set`) does not;
//   * in a file under `apps/`, outside `spec/`, `*.spec.ts` and `*.e2e-spec.ts` — a test that
//     drives a port method directly is arrangement, not a contract (ADR-049 §1 — the nine cache
//     tests that called `get`/`set` were what made the hole comfortable);
//   * the implementing class's declaration and an object-literal double are definitions, not calls,
//     and are ignored by construction (their parent is not a property access).
//
// TypeScript's own find-references does the resolution, so a call through an implementing class's
// type (`stockCache.getOrLoad` on a `StockCache`) is attributed to the port member exactly as a call
// through the interface is.
//
// **Blind spots, stated so nobody trusts it further than it earns.** An element access
// (`repo['save']()`) and a destructured method (`const { save } = repo`) are not recognised — both
// surface as a false RED, which is the safe direction; write the call plainly. A call from dead code
// still counts: this proves a caller exists, not that the caller is reachable.
//
// **A red build has two honest answers:** delete the method from the port, its adapter and its spec
// (ADR-049 §2), or — when the adapter genuinely needs it internally — make it private on the adapter
// (ADR-049 §1). Adding an allowlist to make it green is the ADR-053 failure in a new shape.

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const ROOT = path.resolve(__dirname, '..');

const PORT_FILE = /^apps\/([^/]+)\/src\/modules\/[^/]+\/application\/ports\//;
const TEST_FILE = /(^|\/)spec\/|\.spec\.ts$|\.e2e-spec\.ts$/;

// **The detector proves it can fail before its verdict on the real tree is believed.** A scan that
// resolved no references would report every method uncalled (loudly red — fine); a scan that
// mistook a definition for a call would report nothing, and a suite of green `[]`s would guard
// nothing. So the same program also holds an in-memory module — never written to disk, never seen by
// Jest or the linter — with one member for each rule above, and the first test pins exactly which of
// them the scan reports.
const FIXTURE_APP = '__port-callers-fixture__';
const FIXTURE_MODULE = `apps/${FIXTURE_APP}/src/modules/fixture`;
const FIXTURE_FILES = new Map<string, string>([
  [
    `${FIXTURE_MODULE}/application/ports/fixture.port.ts`,
    `export interface IFixtureRepositoryPort {
       calledByAUseCase(): Promise<void>;
       calledOnlyByItsOwnAdapter(): Promise<void>;
       calledOnlyByASpec(): Promise<void>;
       neverCalled(): Promise<void>;
       propertyStyleCalled: () => Promise<void>;
       propertyStyleNeverCalled: () => Promise<void>;
     }`,
  ],
  [
    `${FIXTURE_MODULE}/infrastructure/persistence/fixture.repository.ts`,
    `import { IFixtureRepositoryPort } from '../../application/ports/fixture.port';
     export class FixtureRepository implements IFixtureRepositoryPort {
       public async calledByAUseCase(): Promise<void> { await this.calledOnlyByItsOwnAdapter(); }
       public async calledOnlyByItsOwnAdapter(): Promise<void> {}
       public async calledOnlyByASpec(): Promise<void> {}
       public async neverCalled(): Promise<void> {}
       public propertyStyleCalled = async (): Promise<void> => {};
       public propertyStyleNeverCalled = async (): Promise<void> => {};
     }`,
  ],
  [
    `${FIXTURE_MODULE}/application/use-cases/fixture.use-case.ts`,
    `import { IFixtureRepositoryPort } from '../ports/fixture.port';
     export class FixtureUseCase {
       constructor(private readonly repository: IFixtureRepositoryPort) {}
       public async execute(): Promise<void> {
         await this.repository.calledByAUseCase();
         await this.repository.propertyStyleCalled();
       }
     }`,
  ],
  [
    `${FIXTURE_MODULE}/application/use-cases/spec/fixture.use-case.spec.ts`,
    `import { FixtureRepository } from '../../../infrastructure/persistence/fixture.repository';
     export async function arrange(): Promise<void> { await new FixtureRepository().calledOnlyByASpec(); }`,
  ],
]);

interface IUncalledMember {
  app: string;
  // `IStockCachePort.get`
  member: string;
  // `apps/…/stock-cache.port.ts:73` — where to go to delete it.
  location: string;
}

interface IScanResult {
  scannedApps: Set<string>;
  scannedMembers: number;
  uncalled: IUncalledMember[];
}

const toRelative = (fileName: string): string =>
  path.relative(ROOT, fileName).split(path.sep).join('/');

// A language service over the SAME `tsconfig.json` the build uses — its `paths` resolve the
// `@retail-inventory-system/*` aliases, and with no `include` it takes every `.ts` under the root —
// plus the in-memory fixture files layered on top.
function createLanguageService(virtualFiles: ReadonlyMap<string, string>): ts.LanguageService {
  const { config, error } = ts.readConfigFile(path.join(ROOT, 'tsconfig.json'), (file) =>
    ts.sys.readFile(file),
  );
  if (error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, ROOT);

  const virtual = new Map([...virtualFiles].map(([file, text]) => [path.join(ROOT, file), text]));
  const readFile = (fileName: string): string | undefined =>
    virtual.get(fileName) ?? ts.sys.readFile(fileName);

  // **Module resolution skips every candidate whose directory does not exist**, so the fixture's
  // directories have to exist as well. Without this its relative imports resolve to nothing, the
  // use case's `repository` is an error type, and every call in it is invisible — which is exactly how
  // this suite's own first test caught it.
  const virtualDirectories = new Set<string>();
  for (const file of virtual.keys()) {
    for (let dir = path.dirname(file); dir.length > ROOT.length; dir = path.dirname(dir)) {
      virtualDirectories.add(dir);
    }
  }

  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => parsed.options,
    getScriptFileNames: () => [...parsed.fileNames, ...virtual.keys()],
    // Nothing is edited during the run, so every file is at one version for its whole life.
    getScriptVersion: () => '1',
    getScriptSnapshot: (fileName) => {
      const text = readFile(fileName);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => ROOT,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (fileName) => virtual.has(fileName) || ts.sys.fileExists(fileName),
    readFile,
    readDirectory: (dir, extensions, exclude, include, depth) =>
      ts.sys.readDirectory(dir, extensions, exclude, include, depth),
    directoryExists: (dir) => virtualDirectories.has(dir) || ts.sys.directoryExists(dir),
    getDirectories: (dir) => ts.sys.getDirectories(dir),
  };

  return ts.createLanguageService(host, ts.createDocumentRegistry());
}

// A method signature, or a property whose declared type is a function — the two ways a port member
// can be something you call.
function isCallableMember(
  member: ts.TypeElement,
): member is ts.MethodSignature | ts.PropertySignature {
  return (
    ts.isMethodSignature(member) ||
    (ts.isPropertySignature(member) &&
      member.type !== undefined &&
      ts.isFunctionTypeNode(member.type))
  );
}

// The chain of nodes from the file down to the token at `position`. Walked with `forEachChild`
// rather than read back through `node.parent`, so it does not depend on the binder having set parents.
function nodeChainAt(sourceFile: ts.SourceFile, position: number): ts.Node[] {
  const chain: ts.Node[] = [];
  let current: ts.Node | undefined = sourceFile;
  while (current !== undefined) {
    chain.push(current);
    current = ts.forEachChild(current, (child) =>
      child.getStart(sourceFile) <= position && position < child.getEnd() ? child : undefined,
    );
  }
  return chain;
}

function isProductionCall(program: ts.Program, reference: ts.ReferencedSymbolEntry): boolean {
  const file = toRelative(reference.fileName);
  if (!file.startsWith('apps/') || TEST_FILE.test(file)) {
    return false;
  }

  const sourceFile = program.getSourceFile(reference.fileName);
  if (sourceFile === undefined) {
    return false;
  }

  const chain = nodeChainAt(sourceFile, reference.textSpan.start);
  const name = chain.at(-1);
  const access = chain.at(-2);
  return (
    access !== undefined &&
    ts.isPropertyAccessExpression(access) &&
    access.name === name &&
    access.expression.kind !== ts.SyntaxKind.ThisKeyword
  );
}

function scanPorts(service: ts.LanguageService): IScanResult {
  const program = service.getProgram();
  if (program === undefined) {
    throw new Error('The language service produced no program — the scan would prove nothing.');
  }

  const result: IScanResult = { scannedApps: new Set(), scannedMembers: 0, uncalled: [] };

  for (const sourceFile of program.getSourceFiles()) {
    const file = toRelative(sourceFile.fileName);
    const portFile = PORT_FILE.exec(file);
    if (portFile === null || TEST_FILE.test(file)) {
      continue;
    }
    const app = portFile[1];

    for (const statement of sourceFile.statements) {
      if (!ts.isInterfaceDeclaration(statement)) {
        continue;
      }

      // Overloads share a name, and one find-references covers them all.
      const seen = new Set<string>();
      for (const member of statement.members) {
        if (
          !isCallableMember(member) ||
          !ts.isIdentifier(member.name) ||
          seen.has(member.name.text)
        ) {
          continue;
        }
        seen.add(member.name.text);
        result.scannedApps.add(app);
        result.scannedMembers += 1;

        const position = member.name.getStart(sourceFile);
        const called = (service.findReferences(sourceFile.fileName, position) ?? []).some(
          ({ references }) => references.some((reference) => isProductionCall(program, reference)),
        );

        if (!called) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(position);
          result.uncalled.push({
            app,
            member: `${statement.name.text}.${member.name.text}`,
            location: `${file}:${line + 1}`,
          });
        }
      }
    }
  }

  return result;
}

describe('port methods have a production caller (ADR-049)', () => {
  let scan: IScanResult;

  // One program over the whole repository, built once. It is the expensive part — every test below
  // only reads its result.
  beforeAll(() => {
    scan = scanPorts(createLanguageService(FIXTURE_FILES));
  }, 300_000);

  it('reports exactly the fixture members that only LOOK called (the detector can fail)', () => {
    const reported = scan.uncalled
      .filter(({ app }) => app === FIXTURE_APP)
      .map(({ member }) => member)
      .sort();

    expect(reported).toEqual([
      'IFixtureRepositoryPort.calledOnlyByASpec',
      'IFixtureRepositoryPort.calledOnlyByItsOwnAdapter',
      'IFixtureRepositoryPort.neverCalled',
      'IFixtureRepositoryPort.propertyStyleNeverCalled',
    ]);
  });

  // A `PORT_FILE` pattern that silently stopped matching one service would leave that service's ports
  // unguarded while the last test stayed green. The app list comes from the disk, not from a copy.
  it('scans the ports of every app under apps/', () => {
    const apps = fs
      .readdirSync(path.join(ROOT, 'apps'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect([...scan.scannedApps].filter((app) => app !== FIXTURE_APP).sort()).toEqual(apps);
  });

  it('leaves no application/ports method without a production caller', () => {
    const uncalled = scan.uncalled
      .filter(({ app }) => app !== FIXTURE_APP)
      .map(
        ({ member, location }) =>
          `\n  ${member} (${location}) — nothing outside a spec calls it.` +
          '\n    Delete it from the port, its adapter and its spec, or make it private on the adapter' +
          ' (ADR-049). Do not allowlist it.',
      );

    expect(uncalled).toEqual([]);
  });
});
