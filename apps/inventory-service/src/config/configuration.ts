import { registerAs } from '@nestjs/config';
import { sharedConfig } from '@retail-system/config';

export default registerAs('inventory', () => ({
  ...sharedConfig(),

  lowStockThreshold: +(process.env.LOW_STOCK_THRESHOLD ?? '10'),
  cacheTtlSeconds: +(process.env.CACHE_TTL_SECONDS ?? '300'),
}));
