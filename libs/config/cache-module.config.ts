import KeyvRedis from '@keyv/redis';
import { CacheModuleAsyncOptions } from '@nestjs/cache-manager';
import { ConfigService } from '@nestjs/config';

export const cacheModuleConfig: CacheModuleAsyncOptions = {
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => ({
    stores: [new KeyvRedis(configService.get<string>('REDIS_URL') ?? 'redis://localhost:6379')],
    ttl: 60_000,
  }),
  isGlobal: true,
};
