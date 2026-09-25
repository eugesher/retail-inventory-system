import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const ROOT = path.resolve(__dirname, '..');

const PORT_FILE = /^apps\/([^/]+)\/src\/modules\/[^/]+\/application\/ports\//;
const TEST_FILE = /(^|\/)spec\/|\.spec\.ts$|\.e2e-spec\.ts$/;

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
  member: string;
  location: string;
}

interface IScanResult {
  scannedApps: Set<string>;
  scannedMembers: number;
  uncalled: IUncalledMember[];
}

const toRelative = (fileName: string): string =>
  path.relative(ROOT, fileName).split(path.sep).join('/');

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

  const virtualDirectories = new Set<string>();
  for (const file of virtual.keys()) {
    for (let dir = path.dirname(file); dir.length > ROOT.length; dir = path.dirname(dir)) {
      virtualDirectories.add(dir);
    }
  }

  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => parsed.options,
    getScriptFileNames: () => [...parsed.fileNames, ...virtual.keys()],
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
