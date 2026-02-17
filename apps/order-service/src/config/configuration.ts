import { registerAs } from '@nestjs/config';
import { sharedConfig } from '@retail-system/config';

export default registerAs('order', () => ({
  ...sharedConfig(),

  maxOrderItems: +(process.env.MAX_ORDER_ITEMS ?? '50'),
}));
