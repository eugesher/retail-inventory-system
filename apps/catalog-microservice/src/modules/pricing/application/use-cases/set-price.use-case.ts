import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  ICatalogPriceChangedEvent,
  ICatalogPriceScheduledEvent,
  IPriceSetPayload,
  PriceView,
} from '@retail-inventory-system/contracts';

import { Price, PricingDomainException, PricingErrorCodeEnum } from '../../domain';
import {
  IPricingEventsPublisherPort,
  IPricingRepositoryPort,
  PRICING_EVENTS_PUBLISHER,
  PRICING_REPOSITORY,
} from '../ports';
import { toPriceView } from './price-view.factory';

@Injectable()
export class SetPriceUseCase {
  constructor(
    @Inject(PRICING_REPOSITORY)
    private readonly repository: IPricingRepositoryPort,
    @Inject(PRICING_EVENTS_PUBLISHER)
    private readonly publisher: IPricingEventsPublisherPort,
    @InjectPinoLogger(SetPriceUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IPriceSetPayload): Promise<PriceView> {
    const { variantId, currency, amountMinor, validFrom, validTo, priority, correlationId } =
      payload;

    this.logger.info(
      { correlationId, variantId, currency, amountMinor },
      'Received RPC: set price',
    );

    const now = new Date();
    const newPrice = Price.set(
      {
        variantId,
        currency,
        amountMinor,
        validFrom: validFrom === undefined ? undefined : new Date(validFrom),
        validTo: validTo === undefined || validTo === null ? null : new Date(validTo),
        priority,
      },
      now,
    );

    const open = await this.repository.findOpenPrice(variantId, currency);
    const predecessorToClose = this.resolvePredecessor(open, newPrice);

    const saved = await this.repository.appendPrice(newPrice, predecessorToClose);

    const isScheduled = newPrice.validFrom.getTime() > now.getTime();

    this.logger.info(
      { correlationId, variantId, currency, priceId: saved.id, isScheduled },
      isScheduled ? 'Price scheduled' : 'Price changed',
    );

    await this.publish(saved, isScheduled, correlationId);

    return toPriceView(saved);
  }

  private resolvePredecessor(open: Price | null, newPrice: Price): Price | null {
    if (open === null) {
      return null;
    }

    if (open.validFrom.getTime() < newPrice.validFrom.getTime()) {
      return open.close(newPrice.validFrom);
    }

    throw new PricingDomainException(
      PricingErrorCodeEnum.PRICE_SCHEDULE_CONFLICT,
      `Cannot set a price starting at ${newPrice.validFrom.toISOString()} for variant ` +
        `#${newPrice.variantId} ${newPrice.currency}: an open price already starts at ` +
        `${open.validFrom.toISOString()} (at or after the requested start). There is no ` +
        'reschedule flow — close or supersede the existing open price first.',
    );
  }

  private async publish(saved: Price, isScheduled: boolean, correlationId: string): Promise<void> {
    const occurredAt = new Date().toISOString();
    const changed: ICatalogPriceChangedEvent = {
      variantId: saved.variantId,
      currency: saved.currency,
      amountMinor: saved.amountMinor,
      validFrom: saved.validFrom.toISOString(),
      validTo: saved.validTo === null ? null : saved.validTo.toISOString(),
      priority: saved.priority,
      eventVersion: 'v1',
      occurredAt,
      correlationId: correlationId ?? '',
    };

    try {
      if (isScheduled) {
        const scheduled: ICatalogPriceScheduledEvent = {
          ...changed,
          effectiveAt: saved.validFrom.toISOString(),
        };
        await this.publisher.publishPriceScheduled(scheduled, correlationId);
      } else {
        await this.publisher.publishPriceChanged(changed, correlationId);
      }
    } catch (err) {
      this.logger.warn(
        { err: err as Error, correlationId, variantId: saved.variantId, currency: saved.currency },
        isScheduled
          ? 'Failed to publish catalog.price.scheduled event'
          : 'Failed to publish catalog.price.changed event',
      );
    }
  }
}
