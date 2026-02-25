import { ConfigObject } from '@nestjs/config';
import { isDefined } from 'class-validator';

import { ConfigPropertyKeyEnum } from '../enums';

export const configObjectGlobal: ConfigObject = {
  [ConfigPropertyKeyEnum.DATABASE_LOGGING]: isDefined(process.env.DATABASE_LOGGING)
    ? process.env.DATABASE_LOGGING === 'true'
    : process.env.NODE_ENV !== 'production',
};
