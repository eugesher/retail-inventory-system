import { createHash } from 'crypto';

function sortObjectKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const source = value as Record<string, unknown>;
  return Object.keys(source)
    .sort()
    .reduce<Record<string, unknown>>((sorted, key) => {
      sorted[key] = source[key];
      return sorted;
    }, {});
}

export function bodyFingerprint(value: unknown): string {
  const canonical = JSON.stringify(value, sortObjectKeys) ?? 'null';
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
