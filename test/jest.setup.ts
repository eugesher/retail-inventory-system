import * as dotenv from 'dotenv';
import * as path from 'path';

import { installMemoryPinoLogger } from '@retail-inventory-system/observability/testing';

dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });

process.env.NODE_ENV = 'test';
process.env.DATABASE_LOGGING = 'false';

// E2E Pino capture (TEST-002): install the memory destination BEFORE the
// spec file's imports run. `LoggerModule.forRoot(new LoggerModuleConfig(...))`
// is evaluated at AppModule load time — if the install happens later
// (e.g. in `beforeAll`), the pino instance is already wired to
// pino-pretty by then. Setup files are the canonical pre-import hook.
//
// The captured-logs array reference is hung off `globalThis` so any spec
// that wants log-based side-channel assertions can `as any`-cast it back.
// Specs that don't care simply ignore it — their logs are silently
// captured into the same array (one fresh array per Jest VM context /
// test file, so files don't pollute each other).
const e2eMemoryLogger = installMemoryPinoLogger();
(
  globalThis as { __RIS_E2E_CAPTURED_LOGS__?: Record<string, unknown>[] }
).__RIS_E2E_CAPTURED_LOGS__ = e2eMemoryLogger.capturedLogs;
