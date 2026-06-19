import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IRetailReturnListPayload, ReturnRequestView } from '@retail-inventory-system/contracts';

import { IReturnRequestRepositoryPort, RETURN_REQUEST_REPOSITORY } from '../ports';
import { toReturnRequestView } from './return-view.factory';

// List Returns For Order resolves one order's RMAs newest-first (the repository orders by
// `requested_at DESC, id DESC`). Authorization is **owner-or-staff** (ADR-028 §7 /
// ADR-032): a staff caller with `order:read` (folded into `isStaff`) sees every RMA on the
// order; a customer sees only RMAs whose buyer matches it (`request.customerId ===
// actorId`). All of an order's RMAs share the same buyer, so for a customer this is
// effectively all-or-nothing — and filtering (rather than a 403) means a non-owner gets an
// empty list with no existence leak, the own-only-list posture (the `ListMyOrders`
// precedent). An order with no RMAs resolves to an empty array.
@Injectable()
export class ListReturnsForOrderUseCase {
  constructor(
    @Inject(RETURN_REQUEST_REPOSITORY)
    private readonly repository: IReturnRequestRepositoryPort,
    @InjectPinoLogger(ListReturnsForOrderUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRetailReturnListPayload): Promise<ReturnRequestView[]> {
    const { orderId, actorId, isStaff, correlationId } = payload;

    this.logger.info({ correlationId, orderId, actorId, isStaff }, 'Listing returns for order');

    const requests = await this.repository.listByOrderId(orderId);
    const visible = isStaff ? requests : requests.filter((r) => r.customerId === actorId);
    return visible.map((request) => toReturnRequestView(request));
  }
}
