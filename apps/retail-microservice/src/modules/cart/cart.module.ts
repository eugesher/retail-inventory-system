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

    {
      provide: OCC_RETRY_ATTEMPTS,
      useFactory: (config: ConfigService): number => config.get<number>('OCC_RETRY_ATTEMPTS') ?? 5,
      inject: [ConfigService],
    },

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
