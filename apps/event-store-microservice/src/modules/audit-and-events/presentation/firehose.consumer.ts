import { Controller } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IAuditStaffActionEvent } from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { IngestAuditLogUseCase, IngestDomainEventUseCase } from '../application/use-cases';

@Controller()
export class FirehoseConsumer {
  constructor(
    private readonly ingestDomainEvent: IngestDomainEventUseCase,
    private readonly ingestAuditLog: IngestAuditLogUseCase,
    @InjectPinoLogger(FirehoseConsumer.name)
    private readonly logger: PinoLogger,
  ) {}

  @EventPattern('#')
  public async onFirehoseEvent(
    @Payload() payload: Record<string, unknown>,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    const message = context.getMessage() as { fields: { routingKey: string } };
    const routingKey = message.fields.routingKey;
    const correlationId = typeof payload?.correlationId === 'string' ? payload.correlationId : '';

    this.logger.debug({ correlationId, routingKey }, 'Consuming ris.events firehose message');

    try {
      if (routingKey === ROUTING_KEYS.AUDIT_STAFF_ACTION) {
        await this.ingestAuditLog.execute(payload as unknown as IAuditStaffActionEvent);
      } else {
        await this.ingestDomainEvent.execute(routingKey, payload);
      }
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, routingKey },
        'Firehose ingest failed — dropping message (never rethrow from @EventPattern)',
      );
    }
  }
}
