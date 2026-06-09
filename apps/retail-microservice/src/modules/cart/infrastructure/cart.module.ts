import { Module } from '@nestjs/common';

import { DatabaseModule } from '@retail-inventory-system/database';

import { CART_REPOSITORY } from '../application/ports';
import { CartEntity, CartLineEntity, CartTypeormRepository } from './persistence';

// Foundation wiring only: the `Cart` aggregate's repository over its two tables.
// No publisher, use cases, or controller yet — the cart operations + their
// gateway land in a later capability, so the retail microservice boots with the
// `cart` module registered but no `@MessagePattern` / `@EventPattern` handlers.
//
// `useExisting` shares the single adapter instance with code that injects the
// concrete class directly, while consumers depend on the `CART_REPOSITORY` port
// symbol (mirrors `stock.module.ts` / `catalog.module.ts`). `DatabaseModule.forFeature`
// registers the two entities' repositories for `@InjectRepository`.
@Module({
  imports: [DatabaseModule.forFeature([CartEntity, CartLineEntity])],
  providers: [
    CartTypeormRepository,
    { provide: CART_REPOSITORY, useExisting: CartTypeormRepository },
  ],
  exports: [CART_REPOSITORY],
})
export class CartModule {}
