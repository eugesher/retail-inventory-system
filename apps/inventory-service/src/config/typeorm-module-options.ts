import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModuleAsyncOptions } from '@nestjs/typeorm';

export const typeormModuleOptions: TypeOrmModuleAsyncOptions = {
  imports: [ConfigModule],
  useFactory: (configService: ConfigService) => ({
    type: 'mysql',
    url: configService.get<string>('DATABASE_URL'),
    autoLoadEntities: true,
    synchronize: false,
    logging: configService.get<boolean>('DATABASE_LOGGING'),
  }),
  inject: [ConfigService],
};
