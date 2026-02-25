import { ConfigModuleOptions, ConfigObject, registerAs } from '@nestjs/config';
import * as Joi from 'joi';

import { globalConfigObject } from './global-config-object';

export class ConfigModuleConfiguration implements ConfigModuleOptions {
  public readonly load: ConfigModuleOptions['load'];

  public readonly validationSchema = Joi.object({
    NODE_ENV: Joi.string().valid('development', 'production', 'test').required(),

    API_GATEWAY_PORT: Joi.number().required().port(),
    API_GATEWAY_PREFIX: Joi.string().required(),

    DATABASE_URL: Joi.string().uri({ scheme: 'mysql' }).required(),
    DATABASE_LOGGING: Joi.boolean().required(),

    RABBITMQ_URL: Joi.string().uri({ scheme: 'amqp' }).required(),

    REDIS_URL: Joi.string().uri({ scheme: 'redis' }).required(),
  }).options({ allowUnknown: true, abortEarly: false });

  public readonly validationOptions: { allowUnknown: true; abortEarly: false };
  public readonly envFilePath = ['.env.local', '.env'];
  public readonly isGlobal = true;

  constructor(token: string | symbol, configObject: ConfigObject = {}) {
    this.load = [
      registerAs('global', () => globalConfigObject),
      registerAs(token, () => configObject),
    ];
  }
}
