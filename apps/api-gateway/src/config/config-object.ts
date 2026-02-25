import { ConfigObject } from '@nestjs/config';
import { ConfigPropertyKeyEnum } from '@retail-inventory/config';

export const configObject: ConfigObject = {
  [ConfigPropertyKeyEnum.USE_API_REFERENCE]: process.env.NODE_ENV !== 'production',
};
