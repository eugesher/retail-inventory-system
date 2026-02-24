import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { configModuleOptions } from '../config';
import { ProductModule } from './api';

@Module({
  imports: [ConfigModule.forRoot(configModuleOptions), ProductModule],
})
export class AppModule {}
