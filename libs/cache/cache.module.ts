import { CacheModule as NestCacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';

import { cacheModuleConfig } from './cache-module.config';
import { CACHE_PORT } from './cache.port';
import { RedisCacheAdapter } from './redis-cache.adapter';

// Wires the Redis-backed adapter behind the `CachePort` symbol. Apps that
// register this module gain a port-typed cache they can inject without
// pulling `@nestjs/cache-manager` directly. Task-08 migrates the
// product-stock cache façade onto this binding.
@Module({
  imports: [NestCacheModule.registerAsync(cacheModuleConfig)],
  providers: [RedisCacheAdapter, { provide: CACHE_PORT, useExisting: RedisCacheAdapter }],
  exports: [NestCacheModule, CACHE_PORT, RedisCacheAdapter],
})
export class CacheModule {}
