import { Module } from '@nestjs/common';

import { DatabaseModule } from '@retail-inventory-system/database';

import { RETURN_REQUEST_REPOSITORY } from '../application/ports';
import {
  ReturnRequestEntity,
  ReturnLineEntity,
  ReturnRequestTypeormRepository,
} from './persistence';

// The returns bounded-context module — the data + domain foundation for the RMA
// lifecycle (ADR-032). It owns the `ReturnRequest` aggregate (root + `ReturnLine`
// children) and its single repository, bound behind the `RETURN_REQUEST_REPOSITORY`
// port symbol. `DatabaseModule.forFeature([...])` registers the two entities so the
// repository's `@InjectRepository` sites resolve.
//
// This is a **providers-only module** for now: the lifecycle operations (Open /
// Authorize / Reject / Receive / Inspect / Close), their controllers, the
// `ReturnRpcExceptionFilter`, the order-reader port, and the events publisher arrive in
// later returns work. A module with only a repository provider boots cleanly — wiring
// it into `app.module.ts` is what makes the migration's tables owned by a live module.
// The repository binding is exported so the later returns operations (in their own
// module) and any cross-module reader can depend on the port symbol.
@Module({
  imports: [DatabaseModule.forFeature([ReturnRequestEntity, ReturnLineEntity])],
  providers: [
    ReturnRequestTypeormRepository,
    { provide: RETURN_REQUEST_REPOSITORY, useExisting: ReturnRequestTypeormRepository },
  ],
  exports: [RETURN_REQUEST_REPOSITORY],
})
export class ReturnsModule {}
