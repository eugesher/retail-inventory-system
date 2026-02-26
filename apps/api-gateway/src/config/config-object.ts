import { ConfigObject } from '@nestjs/config';
import { ConfigPropertyKeyEnum } from '@retail-inventory-system/config';

export const configObject: ConfigObject = {
  [ConfigPropertyKeyEnum.USE_API_REFERENCE]: process.env.NODE_ENV !== 'production',
};
