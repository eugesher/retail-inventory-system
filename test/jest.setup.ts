import * as dotenv from 'dotenv';
import * as path from 'path';

import { installMemoryPinoLogger } from '@retail-inventory-system/observability/testing';

dotenv.config({ path: path.resolve(__dirname, '..', '.env.local'), quiet: true });

process.env.NODE_ENV = 'test';
process.env.DATABASE_LOGGING = 'false';

jest.setTimeout(120_000);

process.env.HEALTH_PROBE_TIMEOUT_MS = '400';

const e2eMemoryLogger = installMemoryPinoLogger();
(
  globalThis as { __RIS_E2E_CAPTURED_LOGS__?: Record<string, unknown>[] }
).__RIS_E2E_CAPTURED_LOGS__ = e2eMemoryLogger.capturedLogs;
