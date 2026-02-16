import { registerAs } from '@nestjs/config';
import sharedConfig from '@libs/config';

export default registerAs('gateway', () => ({
  ...sharedConfig(),

  port: +(process.env.GATEWAY_PORT ?? '3000'),
  prefix: process.env.API_PREFIX ?? 'api/v1',

  graphql: {
    playground: process.env.NODE_ENV !== 'production',
    introspection: process.env.NODE_ENV !== 'production',
  },

  throttle: {
    ttl: +(process.env.THROTTLE_TTL ?? '60'),
    limit: +(process.env.THROTTLE_LIMIT ?? '100'),
  },
}));
