import { Inject } from '@nestjs/common';

import { CACHE_PORT, ICachePort } from '../cache.port';

export interface ICacheableOptions {
  key: string;
  ttlMs: number;
}

const PARAM_PLACEHOLDER = /\{([^}]+)\}/g;

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
  let i = 0;
  return template.replace(PARAM_PLACEHOLDER, () => {
    const value = args[i++];
    return String(value);
  });
}
