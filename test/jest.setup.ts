import * as dotenv from 'dotenv';
import * as path from 'path';

import { installMemoryPinoLogger } from '@retail-inventory-system/observability/testing';

// `quiet: true` silences only dotenv's own "[dotenv] injecting env …" tip
// line. Source-level `console.*` calls are left untouched — they're our local
// debugging channel, so Jest's console is deliberately not globally silenced.
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local'), quiet: true });

process.env.NODE_ENV = 'test';
process.env.DATABASE_LOGGING = 'false';

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
