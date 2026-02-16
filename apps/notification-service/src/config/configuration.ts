import { registerAs } from '@nestjs/config';
import sharedConfig from '@libs/config';

export default registerAs('notification', () => ({
  ...sharedConfig(),

  email: {
    provider: process.env.EMAIL_PROVIDER ?? 'console',
    apiKey: process.env.EMAIL_API_KEY ?? '',
  },
}));
