import { ConfigObject } from '@nestjs/config';

export const configObject: ConfigObject = {
  ['use-api-reference']: process.env.NODE_ENV !== 'production',
};
