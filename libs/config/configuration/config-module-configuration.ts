import { ConfigModuleOptions, ConfigObject, registerAs } from '@nestjs/config';

import { ConfigFactoryTokenEnum } from './enums';
import { configObjectGlobal, configValidationSchema } from './objects';

export class ConfigModuleConfiguration implements ConfigModuleOptions {
  public readonly load: ConfigModuleOptions['load'];

  public readonly validationSchema = configValidationSchema;
  public readonly envFilePath = ['.env.local', '.env'];
  public readonly isGlobal = true;

  constructor(token: ConfigFactoryTokenEnum, configObject: ConfigObject) {
    this.load = [
      registerAs(ConfigFactoryTokenEnum.GLOBAL, () => configObjectGlobal),
      registerAs(token, () => configObject),
    ];
  }
}
