import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { DatabaseModule } from '@retail-inventory-system/database';
import {
  MicroserviceClientCatalogModule,
  MicroserviceClientInventoryModule,
  MicroserviceClientRetailModule,
} from '@retail-inventory-system/messaging';

import {
  CART_CATALOG_GATEWAY,
  CART_EVENTS_PUBLISHER,
  CART_INVENTORY_GATEWAY,
  CART_REPOSITORY,
} from '../application/ports';
import {
  AddToCartUseCase,
  ChangeCartLineQuantityUseCase,
  ClaimCartUseCase,
  CreateCartUseCase,
  GetCartUseCase,
  RemoveFromCartUseCase,
} from '../application/use-cases';
import {
  CartCatalogRabbitmqAdapter,
  CartInventoryRabbitmqAdapter,
  CartRabbitmqPublisher,
} from './messaging';
import { CartEntity, CartLineEntity, CartTypeormRepository } from './persistence';
import { CartController, CartRpcExceptionFilter } from '../presentation';

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
// `MicroserviceClientRetailModule` so the publisher can emit the four reserved
// `retail.cart.*` events onto the service's own `retail_queue`. The
// `CartRpcExceptionFilter` is registered via `APP_FILTER` so it maps every
// `@MessagePattern` handler's `CartDomainException` onto the wire status the
// gateway resolves.
@Module({
  imports: [
    DatabaseModule.forFeature([CartEntity, CartLineEntity]),
    MicroserviceClientCatalogModule,
    MicroserviceClientInventoryModule,
    MicroserviceClientRetailModule,
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
