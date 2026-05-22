import { CacheModule as NestCacheModule } from '@nestjs/cache-manager';
import { Global, Module } from '@nestjs/common';

import { cacheModuleConfig } from './cache-module.config';
import { CACHE_PORT } from './cache.port';
import { RedisCacheAdapter } from './redis-cache.adapter';

// `@Global()` so any feature module can inject `CACHE_PORT` without
// re-importing. The underlying Nest `CacheModule` is also registered
// global (`isGlobal: true` in `cacheModuleConfig`) so `CACHE_MANAGER`
// stays resolvable for the integration tests that resolve it directly.
@Global()
@Module({
  imports: [NestCacheModule.registerAsync(cacheModuleConfig)],
  providers: [RedisCacheAdapter, { provide: CACHE_PORT, useExisting: RedisCacheAdapter }],
  exports: [NestCacheModule, CACHE_PORT, RedisCacheAdapter],
})
export class CacheModule {}
