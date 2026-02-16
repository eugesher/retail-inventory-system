import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from '../config/configuration';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: ['.env.local', '.env'],
      validate: (config) => {
        // Optional: add runtime validation with zod/joi later
        return config;
      },
    }),
  ],
})
export class AppModule {}
