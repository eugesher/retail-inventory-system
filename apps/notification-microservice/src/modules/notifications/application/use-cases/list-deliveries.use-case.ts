import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { clampPageWindow } from '@retail-inventory-system/common';
import {
  INotificationDeliveryListPayload,
  IPage,
  NotificationDeliveryView,
} from '@retail-inventory-system/contracts';

import { INotificationDeliveryRepositoryPort, NOTIFICATION_DELIVERY_REPOSITORY } from '../ports';
import { toNotificationDeliveryView } from './notification-delivery-view.factory';

// List Deliveries: the paginated, filterable audit read of the `notification_delivery`
// trail (ADR-033). Every filter field narrows the scan — `customerId` →
// `recipient_customer_id` (per-customer history), `eventReferenceType` /
// `eventReferenceId` (per-event), `status` (per-lifecycle-state); an absent field widens
// it, so an empty filter lists every delivery, newest-first.
//
// **Uncached by design.** The audit query is low-frequency, operator-driven, and expects
// the latest rows; caching would add an invalidation hop on every dispatch for no
// hit-rate benefit (the inventory movements-ledger precedent). The result reuses the
// canonical `IPage<NotificationDeliveryView>` envelope.
@Injectable()
export class ListDeliveriesUseCase {
  constructor(
    @Inject(NOTIFICATION_DELIVERY_REPOSITORY)
    private readonly repository: INotificationDeliveryRepositoryPort,
    @InjectPinoLogger(ListDeliveriesUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    payload: INotificationDeliveryListPayload,
  ): Promise<IPage<NotificationDeliveryView>> {
    const { customerId, eventReferenceType, eventReferenceId, status, correlationId } = payload;
    // Clamp the untrusted (page, pageSize) — this RMQ handler is directly reachable, so a
    // malformed page (0, negative, fractional) or an oversized pageSize must be normalized
    // before it reaches the repository's `skip((page - 1) * size)` (the catalog list
    // precedent; defaults page→1, size→20, capped at 100).
    const { page, size } = clampPageWindow(payload.page, payload.pageSize);

    this.logger.info(
      { correlationId, customerId, eventReferenceType, eventReferenceId, status, page, size },
      'Received RPC: list notification deliveries (audit read)',
    );

    const deliveriesPage = await this.repository.list(
      { recipientCustomerId: customerId, eventReferenceType, eventReferenceId, status },
      { page, size },
    );

    // `page` / `size` are echoed from the resolved request (the applied paging); `total`
    // is the repository's full-match count, so a client can compute the page count.
    return {
      items: deliveriesPage.items.map(toNotificationDeliveryView),
      total: deliveriesPage.total,
      page: deliveriesPage.page,
      size: deliveriesPage.size,
    };
  }
}
