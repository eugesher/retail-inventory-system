import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { validationSchema } from '@retail-inventory/config';
import { MicroserviceClientsModule } from './common/modules';
import { configuration } from '../config';
import { ProductModule } from './api';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: ['.env.local', '.env'],
      validationSchema,
      validationOptions: {
        allowUnknown: true,
        abortEarly: false,
      },
    }),
    MicroserviceClientsModule,
    ProductModule,
  ],
})
export class AppModule {}
