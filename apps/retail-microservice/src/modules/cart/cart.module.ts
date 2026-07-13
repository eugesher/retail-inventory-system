import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';

import { DatabaseModule } from '@retail-inventory-system/database';
import {
  MicroserviceClientCatalogModule,
  MicroserviceClientInventoryModule,
  MicroserviceClientRetailModule,
  MicroserviceClientRisEventsModule,
} from '@retail-inventory-system/messaging';

import {
  CART_CATALOG_GATEWAY,
  CART_EVENTS_PUBLISHER,
  CART_INVENTORY_GATEWAY,
  CART_REPOSITORY,
  OCC_RETRY_ATTEMPTS,
  RETAIL_DEFAULT_CURRENCY,
} from './application/ports';
import {
  AddToCartUseCase,
  ChangeCartLineQuantityUseCase,
  ClaimCartUseCase,
  CreateCartUseCase,
  GetCartUseCase,
  RemoveFromCartUseCase,
} from './application/use-cases';
import {
  CartCatalogRabbitmqAdapter,
  CartInventoryRabbitmqAdapter,
  CartRabbitmqPublisher,
} from './infrastructure/messaging';
import { CartTypeormRepository, cartEntities } from './infrastructure/persistence';
import { CartController, CartRpcExceptionFilter } from './presentation';

// The cart bounded-context module: the `Cart` aggregate's two-table repository,
// the six cart operations, their RPC controller, and the two outbound seams.
// `useExisting` shares the single adapter instance with code that injects the
// concrete class directly, while use cases depend on the port symbols (the
// `stock.module.ts` / `catalog.module.ts` pattern).
//
// Three messaging clients are imported: `MicroserviceClientCatalogModule` so the
// Add-to-Cart price snapshot can call `catalog.price.select` on `catalog_queue`;
// `MicroserviceClientInventoryModule` so Add/Change/Remove can reserve/release
// stock via `inventory.reservation.*` on `inventory_queue` (ADR-030); and
// `MicroserviceClientRetailModule` so the publisher can emit the reserved
// `retail.cart.*` events onto the service's own `retail_queue`; and
// `MicroserviceClientRisEventsModule` so the publisher can mirror those same events
// onto the `ris.events` topic exchange for the event-store firehose (ADR-035, the
// `RisEventsMirrorPublisher` dual-publish). The `CartRpcExceptionFilter` is
// registered via `APP_FILTER` so it maps every `@MessagePattern` handler's
// `CartDomainException` onto the wire status the gateway resolves.
@Module({
  imports: [
    DatabaseModule.forFeature(cartEntities),
    MicroserviceClientCatalogModule,
    MicroserviceClientInventoryModule,
    MicroserviceClientRetailModule,
    MicroserviceClientRisEventsModule,
  ],
  controllers: [CartController],
  providers: [
    CartTypeormRepository,
    { provide: CART_REPOSITORY, useExisting: CartTypeormRepository },

    CartCatalogRabbitmqAdapter,
    { provide: CART_CATALOG_GATEWAY, useExisting: CartCatalogRabbitmqAdapter },

    CartInventoryRabbitmqAdapter,
    { provide: CART_INVENTORY_GATEWAY, useExisting: CartInventoryRabbitmqAdapter },

    CartRabbitmqPublisher,
    { provide: CART_EVENTS_PUBLISHER, useExisting: CartRabbitmqPublisher },

    // The bounded optimistic-concurrency retry budget, resolved from
    // `OCC_RETRY_ATTEMPTS` (Joi default 5) so every cart mutator injects a plain
    // number rather than reading env (ADR-036; the inventory `stock.module.ts`
    // precedent). Threaded into `runWithCartWriteRetry`.
    {
      provide: OCC_RETRY_ATTEMPTS,
      useFactory: (config: ConfigService): number => config.get<number>('OCC_RETRY_ATTEMPTS') ?? 5,
      inject: [ConfigService],
    },

    // The currency a cart opens in when the caller names none, resolved from the SAME
    // `DEFAULT_CURRENCY` env var catalog reads (Joi: 3 chars, uppercased, default `USD`).
    // Sharing the variable is the point — see `RETAIL_DEFAULT_CURRENCY`. The `?? 'USD'`
    // matters only if the env is bypassed entirely (a unit boot without config), exactly
    // as in `catalog.module.ts` and the `OCC_RETRY_ATTEMPTS` provider above.
    {
      provide: RETAIL_DEFAULT_CURRENCY,
      useFactory: (config: ConfigService): string =>
        config.get<string>('DEFAULT_CURRENCY') ?? 'USD',
      inject: [ConfigService],
    },

    CreateCartUseCase,
    GetCartUseCase,
    AddToCartUseCase,
    ChangeCartLineQuantityUseCase,
    RemoveFromCartUseCase,
    ClaimCartUseCase,

    { provide: APP_FILTER, useClass: CartRpcExceptionFilter },
  ],
  exports: [CART_REPOSITORY],
})
export class CartModule {}
