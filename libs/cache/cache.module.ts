import { CacheModule as NestCacheModule } from '@nestjs/cache-manager';
import { Global, Module } from '@nestjs/common';

import { cacheModuleConfig } from './cache-module.config';
import { CACHE_PORT } from './cache.port';
import { RedisCacheAdapter } from './redis-cache.adapter';

@Global()
@Module({
  imports: [NestCacheModule.registerAsync(cacheModuleConfig)],
  providers: [RedisCacheAdapter, { provide: CACHE_PORT, useExisting: RedisCacheAdapter }],
  exports: [NestCacheModule, CACHE_PORT, RedisCacheAdapter],
})
export class CacheModule {}
