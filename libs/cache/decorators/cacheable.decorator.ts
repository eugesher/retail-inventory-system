import { Inject } from '@nestjs/common';

import { CACHE_PORT, ICachePort } from '../cache.port';

export interface ICacheableOptions {
  // Key template with `{paramName}` placeholders that resolve from the
  // decorated method's named arguments. Example: `ris:retail:product:{id}`.
  key: string;
  ttlMs: number;
}

const PARAM_PLACEHOLDER = /\{([^}]+)\}/g;

// Method decorator that wraps the call in read-through caching keyed by a
// template string. The decorator injects a `CACHE_PORT` property via Nest's
// `Inject()`, so the decorated class does not need to declare one.
export function Cacheable(options: ICacheableOptions): MethodDecorator {
  return (target, propertyKey, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (...args: unknown[]) => Promise<unknown>;
    const portKey = '__cachePort__';

    Inject(CACHE_PORT)(target, portKey);

    descriptor.value = async function (
      this: { [portKey]: ICachePort } & Record<string, unknown>,
      ...args: unknown[]
    ): Promise<unknown> {
      const port = this[portKey];
      const key = renderKey(options.key, args);
      return port.wrap(key, options.ttlMs, () => original.apply(this, args));
    };

    return descriptor;
  };
}

function renderKey(template: string, args: unknown[]): string {
  // Positional rendering only: a single placeholder maps to args[0], two
  // to args[0]/args[1] in declaration order. Named-arg resolution would
  // need parameter-name reflection that decorators cannot reach without
  // ts-morph or a runtime scan.
  let i = 0;
  return template.replace(PARAM_PLACEHOLDER, () => {
    const value = args[i++];
    return String(value);
  });
}
