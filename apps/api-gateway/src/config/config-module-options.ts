import { ConfigModuleOptions, registerAs } from '@nestjs/config';
import { sharedConfiguration, validationSchema } from '@retail-inventory/config';

export const configModuleOptions: ConfigModuleOptions = {
  isGlobal: true,
  envFilePath: ['.env.local', '.env'],
  validationSchema,
  validationOptions: { allowUnknown: true, abortEarly: false },
  load: [
    registerAs('api-gateway', () => ({
      ...sharedConfiguration,

      ['use-api-reference']: process.env.NODE_ENV !== 'production',
    })),
  ],
};
