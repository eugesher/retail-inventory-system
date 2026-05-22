import { Writable } from 'stream';

// E2E helper: installs a memory-backed Pino destination so the test can
// assert on log records as a side-channel (TEST-002 in
// audit-2026-05-20-followup). The companion read at module-init time
// lives in `libs/observability/logger.module.ts` and looks for the same
// `globalThis` key — see the `E2E_PINO_DESTINATION_KEY` constant
// re-exported below for the shared contract.

export const E2E_PINO_DESTINATION_KEY = '__RIS_E2E_PINO_DESTINATION__';

export interface IPinoMemoryCapture {
  capturedLogs: Record<string, unknown>[];
  uninstall: () => void;
}

const globalSlot = (): Record<string, NodeJS.WritableStream | undefined> =>
  globalThis as unknown as Record<string, NodeJS.WritableStream | undefined>;

export const installMemoryPinoLogger = (): IPinoMemoryCapture => {
  const capturedLogs: Record<string, unknown>[] = [];

  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback): void {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          capturedLogs.push(JSON.parse(trimmed) as Record<string, unknown>);
        } catch {
          // Non-JSON lines (e.g. bare strings from third-party code) are
          // ignored; capturing them as raw text would make assertions
          // brittle without enabling any new side-channel.
        }
      }
      callback();
    },
  });

  globalSlot()[E2E_PINO_DESTINATION_KEY] = stream;

  return {
    capturedLogs,
    uninstall: (): void => {
      delete globalSlot()[E2E_PINO_DESTINATION_KEY];
    },
  };
};
