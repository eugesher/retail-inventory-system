import { registerAs } from '@nestjs/config';

export const sharedConfig = registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: +(process.env.PORT ?? '3000'),

  database: {
    database: {
      url: process.env.DATABASE_URL ?? 'mysql://retail:retailpass@localhost:3306/retail_db',
      // host: process.env.DB_HOST || 'localhost',
      // port: +(process.env.DB_PORT ?? '3306'),
      // username: process.env.DB_USER || 'retail',
      // password: process.env.DB_PASS || 'retailpass',
      // database: process.env.DB_NAME || 'retail_db',
    },
  },

  redis: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  },

  rabbitmq: {
    url: process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672',
  },

  jwt: {
    secret: process.env.JWT_SECRET ?? 'super-secret-change-me-in-prod',
    expiresIn: process.env.JWT_EXPIRES_IN ?? '1d',
  },

  sentry: {
    dsn: process.env.SENTRY_DSN ?? '',
  },

  features: {
    enableGraphQL: process.env.ENABLE_GRAPHQL === 'true' || true,
    enableSwagger: process.env.ENABLE_SWAGGER === 'true' || true,
  },
}));
