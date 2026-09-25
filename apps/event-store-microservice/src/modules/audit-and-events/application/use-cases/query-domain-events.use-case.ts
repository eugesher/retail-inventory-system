import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { clampPageWindow } from '@retail-inventory-system/common';
import {
  DomainEventView,
  IDomainEventQueryPayload,
  IPage,
} from '@retail-inventory-system/contracts';

import { DOMAIN_EVENT_REPOSITORY, IDomainEventRepositoryPort } from '../ports';
import { toDomainEventView } from './domain-event-view.factory';

@Injectable()
export class QueryDomainEventsUseCase {
  constructor(
    @Inject(DOMAIN_EVENT_REPOSITORY)
    private readonly repository: IDomainEventRepositoryPort,
    @InjectPinoLogger(QueryDomainEventsUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IDomainEventQueryPayload): Promise<IPage<DomainEventView>> {
    const { correlationId } = payload;
    const filters = payload.filters ?? {};

    const { page, size } = clampPageWindow(payload.page, payload.pageSize, {
      defaultPage: 1,
      defaultSize: 20,
      maxSize: 100,
    });

    this.logger.info(
      { correlationId, filters, page, size },
      'Received RPC: query domain events (firehose audit read)',
    );

    const eventsPage = await this.repository.query(filters, { page, size });

    return {
      items: eventsPage.items.map(toDomainEventView),
      total: eventsPage.total,
      page: eventsPage.page,
      size: eventsPage.size,
    };
  }
}
