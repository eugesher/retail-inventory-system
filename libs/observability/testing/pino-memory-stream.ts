import { Writable } from 'stream';

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
          continue;
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
