import { registerAs } from '@nestjs/config';
import { sharedConfiguration } from '@retail-inventory/config';

export const configuration = registerAs('api-gateway', () => ({
  ...sharedConfiguration(),

  ['use-api-reference']: process.env.NODE_ENV !== 'production',
}));
