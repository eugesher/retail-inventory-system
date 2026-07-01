import { createHash } from 'crypto';

// A `JSON.stringify` replacer that rebuilds every plain object with its own keys
// in ascending (Unicode code-point) order. `JSON.stringify` serializes an
// object's enumerable string keys in insertion order, so returning a freshly
// built object whose keys were *inserted* sorted makes the emitted key order
// stable at every nesting level. Arrays are returned untouched — their order is
// significant (a reordered cart-line list is a different body). Primitives and
// `null` pass through unchanged.
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

/**
 * Deterministic request-body fingerprint. Canonicalizes a JSON-serializable
 * value — recursively sorting object keys at every depth while preserving array
 * order — and returns the lowercase, 64-character SHA-256 hex digest of that
 * canonical form. Fits the `CHAR(64)` `request_fingerprint` column exactly.
 *
 * It is the *same-key / different-body* discriminator for the idempotency store:
 * two requests with identical logical content produce the identical digest
 * (safe replay), while any change to a value, a type (`1` vs `"1"`), an array's
 * order, or the presence of a key produces a different digest (key-reuse, a
 * `422`).
 *
 * Policy for absent vs `undefined` vs `null` (matching `JSON.stringify`):
 * - A key whose value is `undefined` is **dropped**, so it is indistinguishable
 *   from an absent key.
 * - `null` is **retained** and distinct from both absent and `undefined`.
 * - An `undefined` array element is coerced to `null` (array order is preserved).
 *
 * Framework-free: it depends only on Node's built-in `crypto`. It canonicalizes
 * *whatever object it is handed* and does not reach into HTTP — choosing the
 * stable logical body (e.g. the command payload minus correlation / owner-
 * injected fields) is the caller's responsibility, so the gateway and the retail
 * service can agree on one digest from the same logical body.
 */
export function bodyFingerprint(value: unknown): string {
  // `JSON.stringify` returns `undefined` for a top-level `undefined` / function /
  // symbol; coalesce to the canonical `'null'` so the hash input is always a
  // string and the digest is always well-defined.
  const canonical = JSON.stringify(value, sortObjectKeys) ?? 'null';
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
