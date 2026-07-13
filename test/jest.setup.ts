import * as dotenv from 'dotenv';
import * as path from 'path';

import { installMemoryPinoLogger } from '@retail-inventory-system/observability/testing';

// `quiet: true` silences only dotenv's own "[dotenv] injecting env …" tip
// line. Source-level `console.*` calls are left untouched — they're our local
// debugging channel, so Jest's console is deliberately not globally silenced.
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local'), quiet: true });

process.env.NODE_ENV = 'test';
process.env.DATABASE_LOGGING = 'false';

// A probe against a dead service must not idle for the 2 s production default (ADR-044).
// It MUST be set here, not in a spec's `beforeAll`: `ConfigModule.forRoot(configModuleConfig)`
// sits in a `@Module` decorator argument, so it loads dotenv and runs Joi at AppModule
// *import* time — and a spec's imports are hoisted above its `beforeAll`. The same trap the
// pino note below describes.
process.env.HEALTH_PROBE_TIMEOUT_MS = '400';

// E2E Pino capture (TEST-002): install the memory destination BEFORE the
// spec file's imports run. `LoggerModule.forRoot(new LoggerModuleConfig(...))`
// is evaluated at AppModule load time — moving this into `beforeAll` would
// leave the pino instance already wired to pino-pretty. Hung off `globalThis`
// so specs can opt into log-based assertions; one fresh array per Jest VM
// context, so test files don't pollute each other.
const e2eMemoryLogger = installMemoryPinoLogger();
(
  globalThis as { __RIS_E2E_CAPTURED_LOGS__?: Record<string, unknown>[] }
).__RIS_E2E_CAPTURED_LOGS__ = e2eMemoryLogger.capturedLogs;
