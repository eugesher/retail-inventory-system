import { Module } from '@nestjs/common';

import { AuthModule } from '../auth';
import { CustomerAdminController } from './presentation';

// The customer-admin surface is a presentation-and-orchestration shell over the
// auth module's `Customer` aggregate + consent — no `domain/` of its own, the
// `iam` module precedent (ADR-024). It imports `AuthModule` to resolve the two
// exported use cases (`ReadConsentUseCase`, `EraseCustomerUseCase`) rather than
// re-registering any repository/adapter — re-binding them here would duplicate the
// providers and break the singletons the auth module already holds (the JWT
// strategy, the erasure writer's `EntityManager`).
@Module({
  imports: [AuthModule],
  controllers: [CustomerAdminController],
})
export class CustomerAdminModule {}
