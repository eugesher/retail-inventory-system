import KeyvRedis from '@keyv/redis';
import { CacheModuleAsyncOptions } from '@nestjs/cache-manager';
import { ConfigService } from '@nestjs/config';

export const cacheModuleConfig: CacheModuleAsyncOptions = {
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => ({
    stores: [new KeyvRedis(configService.get<string>('REDIS_URL'))],
    ttl: configService.get<number>('CACHE_TTL_MS_DEFAULT'),
  }),
  isGlobal: true,
};
