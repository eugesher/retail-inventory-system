import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IRetailReturnAuthorizedEvent,
  IRetailReturnInspectedEvent,
  IRetailReturnReceivedEvent,
  IRetailReturnRequestedEvent,
} from '@retail-inventory-system/contracts';

import { Notification, NotificationChannelEnum } from '../../domain';
import { INotifierPort, NOTIFIER } from '../ports';

// Fans the four buyer-facing return lifecycle events — `retail.return.requested`,
// `.authorized`, `.received`, and `.inspected` — out through the notifier. One use case
// with a typed entry method per kind (mirroring `SendShipmentNotificationUseCase`'s
// `shipped`/`delivered`): each event carries a different status-specific field
// (`lineCount` / `authorizedAt` / `receivedAt` / `inspectedAt` + `restockedLineCount`),
// so a method per kind keeps each `Notification` body honest without a discriminated-union
// cast.
//
// Each return event identifies the buyer (`customerId`), so the recipient is derived from
// it (`customer:<id>`) — the buyer is who hears about their own return. (A real recipient
// — an email/phone resolved from the customer record — and templated rendering are a later
// notification capability; the recipient string is a placeholder the log adapter prints.)
//
// Delivery is the `LogNotifierAdapter` this capability — the body is a structured log
// line; templated email/SMS confirmation is deferred. The `correlationId` is logged
// inline (never via `PinoLogger.assign`, which throws outside request scope, ADR-011 §7).
@Injectable()
export class SendReturnNotificationUseCase {
  constructor(
    @Inject(NOTIFIER)
    private readonly notifier: INotifierPort,
    @InjectPinoLogger(SendReturnNotificationUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async requested(event: IRetailReturnRequestedEvent): Promise<void> {
    const notification = new Notification({
      recipient: `customer:${event.customerId}`,
      channel: NotificationChannelEnum.LOG,
      subject: `Return request ${event.rmaNumber} received for order ${event.orderId}`,
      body:
        `Return ${event.rmaNumber} (RMA ${event.rmaId}) for order ${event.orderId} was ` +
        `opened with ${event.lineCount} line(s) at ${event.requestedAt}. We'll review it shortly.`,
      metadata: {
        rmaId: event.rmaId,
        rmaNumber: event.rmaNumber,
        orderId: event.orderId,
        customerId: event.customerId,
        requestedAt: event.requestedAt,
        lineCount: event.lineCount,
        occurredAt: event.occurredAt,
      },
    });

    this.logger.info(
      {
        correlationId: event.correlationId,
        rmaId: event.rmaId,
        rmaNumber: event.rmaNumber,
        orderId: event.orderId,
        customerId: event.customerId,
      },
      'Dispatching return-requested notification',
    );

    await this.notifier.send(notification);
  }

  public async authorized(event: IRetailReturnAuthorizedEvent): Promise<void> {
    const notification = new Notification({
      recipient: `customer:${event.customerId}`,
      channel: NotificationChannelEnum.LOG,
      subject: `Return ${event.rmaNumber} authorized for order ${event.orderId}`,
      body:
        `Return ${event.rmaNumber} (RMA ${event.rmaId}) for order ${event.orderId} was ` +
        `authorized at ${event.authorizedAt}. Please ship the items back to us.`,
      metadata: {
        rmaId: event.rmaId,
        rmaNumber: event.rmaNumber,
        orderId: event.orderId,
        customerId: event.customerId,
        authorizedAt: event.authorizedAt,
        occurredAt: event.occurredAt,
      },
    });

    this.logger.info(
      {
        correlationId: event.correlationId,
        rmaId: event.rmaId,
        rmaNumber: event.rmaNumber,
        orderId: event.orderId,
        customerId: event.customerId,
      },
      'Dispatching return-authorized notification',
    );

    await this.notifier.send(notification);
  }

  public async received(event: IRetailReturnReceivedEvent): Promise<void> {
    const notification = new Notification({
      recipient: `customer:${event.customerId}`,
      channel: NotificationChannelEnum.LOG,
      subject: `Return ${event.rmaNumber} received for order ${event.orderId}`,
      body:
        `We've received the items for return ${event.rmaNumber} (RMA ${event.rmaId}) on ` +
        `order ${event.orderId} at ${event.receivedAt}. They're now being inspected.`,
      metadata: {
        rmaId: event.rmaId,
        rmaNumber: event.rmaNumber,
        orderId: event.orderId,
        customerId: event.customerId,
        receivedAt: event.receivedAt,
        occurredAt: event.occurredAt,
      },
    });

    this.logger.info(
      {
        correlationId: event.correlationId,
        rmaId: event.rmaId,
        rmaNumber: event.rmaNumber,
        orderId: event.orderId,
        customerId: event.customerId,
      },
      'Dispatching return-received notification',
    );

    await this.notifier.send(notification);
  }

  public async inspected(event: IRetailReturnInspectedEvent): Promise<void> {
    const notification = new Notification({
      recipient: `customer:${event.customerId}`,
      channel: NotificationChannelEnum.LOG,
      subject: `Return ${event.rmaNumber} inspected for order ${event.orderId}`,
      body:
        `Return ${event.rmaNumber} (RMA ${event.rmaId}) for order ${event.orderId} was ` +
        `inspected at ${event.inspectedAt}; ${event.restockedLineCount} line(s) returned to inventory.`,
      metadata: {
        rmaId: event.rmaId,
        rmaNumber: event.rmaNumber,
        orderId: event.orderId,
        customerId: event.customerId,
        inspectedAt: event.inspectedAt,
        restockedLineCount: event.restockedLineCount,
        occurredAt: event.occurredAt,
      },
    });

    this.logger.info(
      {
        correlationId: event.correlationId,
        rmaId: event.rmaId,
        rmaNumber: event.rmaNumber,
        orderId: event.orderId,
        customerId: event.customerId,
        restockedLineCount: event.restockedLineCount,
      },
      'Dispatching return-inspected notification',
    );

    await this.notifier.send(notification);
  }
}
