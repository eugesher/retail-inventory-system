import { ConfigObject } from '@nestjs/config';
import { ConfigFactoryTokenEnum } from '../enums';

export interface IConfigModuleConfigurationOptions {
  token: ConfigFactoryTokenEnum;
  configObject: ConfigObject;
}
