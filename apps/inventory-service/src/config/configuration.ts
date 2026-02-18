import { registerAs } from '@nestjs/config';
import { sharedConfiguration } from '@retail-inventory/config';

export const configuration = registerAs('inventory-service', () => ({ ...sharedConfiguration() }));
