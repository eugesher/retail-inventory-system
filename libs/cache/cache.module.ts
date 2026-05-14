import { CacheModule as NestCacheModule } from '@nestjs/cache-manager';
import { Global, Module } from '@nestjs/common';

import { cacheModuleConfig } from './cache-module.config';
import { CACHE_PORT } from './cache.port';
import { RedisCacheAdapter } from './redis-cache.adapter';

// Wires the Redis-backed adapter behind the `CachePort` symbol. Apps register
// this module once at the root; every feature module that injects
// `CACHE_PORT` resolves it without re-importing — the `@Global()` decorator
// here removes the per-module boilerplate. The underlying Nest
// `CacheModule` is itself global (`isGlobal: true` in `cacheModuleConfig`),
// which keeps `CACHE_MANAGER` resolvable for the few integration tests that
// still resolve it directly.
@Global()
@Module({
  imports: [NestCacheModule.registerAsync(cacheModuleConfig)],
  providers: [RedisCacheAdapter, { provide: CACHE_PORT, useExisting: RedisCacheAdapter }],
  exports: [NestCacheModule, CACHE_PORT, RedisCacheAdapter],
})
export class CacheModule {}
