import { ConfigFactoryTokenEnum } from './config-factory-token.enum';
import { ConfigPropertyKeyEnum } from './config-property-key.enum';

export enum ConfigPropertyPathEnum {
  GLOBAL_DATABASE_LOGGING = `${ConfigFactoryTokenEnum.GLOBAL}.${ConfigPropertyKeyEnum.DATABASE_LOGGING}`,
  API_GATEWAY_USE_API_REFERENCE = `${ConfigFactoryTokenEnum.API_GATEWAY}.${ConfigPropertyKeyEnum.USE_API_REFERENCE}`,
}
