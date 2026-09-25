import { Module } from '@nestjs/common';

import { AuthModule } from '../auth';
import { CustomerAdminController } from './presentation';

@Module({
  imports: [AuthModule],
  controllers: [CustomerAdminController],
})
export class CustomerAdminModule {}
