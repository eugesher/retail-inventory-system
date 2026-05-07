import { ConfigModuleOptions } from '@nestjs/config';

import { configValidationSchema } from './config-validation-schema';

export class ConfigModuleConfig implements ConfigModuleOptions {
  public readonly validationSchema = configValidationSchema;
  public readonly envFilePath = ['.env.local', '.env'];
  public readonly isGlobal = true;
}
