import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { DomainEvent } from '../../domain';
import { DOMAIN_EVENT_REPOSITORY, IDomainEventRepositoryPort } from '../ports';
import { resolveAggregateId, resolveAggregateType, resolveProducer } from './firehose-extractors';

@Injectable()
export class IngestDomainEventUseCase {
  constructor(
    @Inject(DOMAIN_EVENT_REPOSITORY)
    private readonly repository: IDomainEventRepositoryPort,
    @InjectPinoLogger(IngestDomainEventUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(routingKey: string, payload: Record<string, unknown>): Promise<void> {
    const correlationId =
      typeof payload.correlationId === 'string' && payload.correlationId.length > 0
        ? payload.correlationId
        : '';

    const occurredAt = this.parseOccurredAt(payload.occurredAt);
    if (occurredAt === null) {
      this.logger.warn(
        { correlationId, routingKey, occurredAt: payload.occurredAt },
        'Dropping firehose event — missing or invalid occurredAt',
      );
      return;
    }

    const tokens = routingKey.split('.');

    try {
      const event = DomainEvent.create({
        eventType: routingKey,
        aggregateType: resolveAggregateType(tokens),
        aggregateId: resolveAggregateId(payload),
        payload,
        eventVersion: typeof payload.eventVersion === 'string' ? payload.eventVersion : 'v1',
        producer: resolveProducer(tokens),
        correlationId,
        occurredAt,
      });

      const { inserted } = await this.repository.append(event);

      if (inserted) {
        this.logger.debug(
          { correlationId, routingKey, producer: event.producer, aggregateId: event.aggregateId },
          'Firehose event appended to domain_event',
        );
      } else {
        this.logger.debug(
          { correlationId, routingKey, aggregateId: event.aggregateId },
          'Duplicate domain_event dropped — idempotent no-op',
        );
      }
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, routingKey },
        'Failed to ingest firehose event — dropping message',
      );
    }
  }

  private parseOccurredAt(raw: unknown): Date | null {
    if (typeof raw !== 'string' || raw.length === 0) {
      return null;
    }
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }
}
