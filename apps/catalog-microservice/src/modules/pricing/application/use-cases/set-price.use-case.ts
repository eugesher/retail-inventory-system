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

// Set / Schedule Price — one use case behind one RPC (`catalog.price.set`). An
// **immediate** price (no `validFrom`, or `validFrom <= now`) and a **scheduled**
// future price (`validFrom > now`) take the same path; they differ only by the
// `validFrom` instant and by which event is emitted afterwards.
//
// A price change is append-only (ADR-026): rather than edit the open row, the use
// case closes the predecessor's interval at the new `validFrom` and appends the
// successor — the repository does both in one transaction. Scheduling leaves the
// current answer unchanged until `validFrom` precisely because the predecessor is
// closed *at* the future instant, so `[predecessor.validFrom, validFrom)` still
// contains "now". The post-commit event publish is best-effort: a broker failure
// is warn-logged and swallowed, the row is already persisted (ADR-020).
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

    // The domain rejects a past `validFrom`, a bad currency/amount/priority, and
    // an inverted interval. `now` is captured once so the immediate-vs-scheduled
    // decision below uses the same instant the domain defaulted `validFrom` to.
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

    // The single open row for the scope, if any. The successor's interval must
    // begin strictly after it so the two tile without overlap.
    const open = await this.repository.findOpenPrice(variantId, currency);
    const predecessorToClose = this.resolvePredecessor(open, newPrice);

    const saved = await this.repository.appendPrice(newPrice, predecessorToClose);

    // Immediate vs scheduled: a `validFrom` strictly after now is a future price.
    // Classify from the *intended* instant (`newPrice.validFrom`), NOT the
    // round-tripped `saved.validFrom`. The `valid_from` column is second-granular
    // (`TIMESTAMP(0)`), so MySQL rounds the sub-second instant to the nearest
    // second and can round *up* — pushing a just-set immediate price up to ~1s
    // into the future. Reading `saved.validFrom` here would then report
    // `> now` for an immediate change and emit `catalog.price.scheduled` instead
    // of `catalog.price.changed` (~half the time, whenever now's ms ≥ 500). The
    // pre-persist `newPrice.validFrom` is exactly the instant the caller meant.
    const isScheduled = newPrice.validFrom.getTime() > now.getTime();

    this.logger.info(
      { correlationId, variantId, currency, priceId: saved.id, isScheduled },
      isScheduled ? 'Price scheduled' : 'Price changed',
    );

    await this.publish(saved, isScheduled, correlationId);

    return toPriceView(saved);
  }

  // Decides which (if any) predecessor row to close so the new interval can be
  // appended without producing two open rows for the scope.
  private resolvePredecessor(open: Price | null, newPrice: Price): Price | null {
    // First price for the scope — nothing to close.
    if (open === null) {
      return null;
    }

    // The current open row ends exactly when the new one starts. Closing it at
    // the new `validFrom` is what keeps the current answer unchanged until then
    // (the scheduling guarantee).
    if (open.validFrom.getTime() < newPrice.validFrom.getTime()) {
      return open.close(newPrice.validFrom);
    }

    // The open row starts at-or-after the new row: a new interval cannot begin
    // before an already-open one (there is no cancel/reschedule flow here).
    throw new PricingDomainException(
      PricingErrorCodeEnum.PRICE_SCHEDULE_CONFLICT,
      `Cannot set a price starting at ${newPrice.validFrom.toISOString()} for variant ` +
        `#${newPrice.variantId} ${newPrice.currency}: an open price already starts at ` +
        `${open.validFrom.toISOString()} (at or after the requested start). There is no ` +
        'reschedule flow — close or supersede the existing open price first.',
    );
  }

  // Best-effort post-commit publish. Builds the versioned `v1` wire event from
  // the persisted row (the `Price` records no `DomainEvent`, so there is nothing
  // to drain — the saved row is the source of truth). A failure never raises.
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
      // Publish failures never raise — the price is already persisted.
      this.logger.warn(
        { err: err as Error, correlationId, variantId: saved.variantId, currency: saved.currency },
        isScheduled
          ? 'Failed to publish catalog.price.scheduled event'
          : 'Failed to publish catalog.price.changed event',
      );
    }
  }
}
