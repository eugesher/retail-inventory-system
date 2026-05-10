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
// template string. The decorated class must own a `ICachePort` member —
// the decorator injects one via Nest's property `Inject()` if missing.
//
// Generalized application across services is task-11; task-04 lands the
// shape so consumers can opt in incrementally.
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
  // Positional rendering: a single placeholder maps to args[0], two to
  // args[0]/args[1] in declaration order. Named-arg resolution would require
  // reflection that decorators don't have access to without ts-morph or a
  // runtime scan; out of scope for task-04.
  let i = 0;
  return template.replace(PARAM_PLACEHOLDER, () => {
    const value = args[i++];
    return String(value);
  });
}
