import { registerAs } from '@nestjs/config';

export const sharedConfiguration = registerAs('retail-inventory', () => ({}));
