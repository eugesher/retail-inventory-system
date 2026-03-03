import { ConfigModuleOptions, registerAs } from '@nestjs/config';

import { ConfigFactoryTokenEnum } from './enums';
import { IConfigModuleConfigurationOptions } from './interfaces';
import { configObjectGlobal, configValidationSchema } from './objects';

export class ConfigModuleConfiguration implements ConfigModuleOptions {
  public readonly load: ConfigModuleOptions['load'];

  public readonly validationSchema = configValidationSchema;
  public readonly envFilePath = ['.env.local', '.env'];
  public readonly isGlobal = true;

  constructor(options: IConfigModuleConfigurationOptions) {
    const { token, configObject } = options;

    this.load = [
      registerAs(ConfigFactoryTokenEnum.GLOBAL, () => configObjectGlobal),
      registerAs(token, () => configObject),
    ];
  }
}
