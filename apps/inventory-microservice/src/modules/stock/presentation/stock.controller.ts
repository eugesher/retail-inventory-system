import { Controller } from '@nestjs/common';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';

import { IProductStockOrderConfirmPayload } from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

@Controller()
export class StockController {
  // The `inventory.order.confirm` seam is preserved as an explicit deprecation
  // error rather than removed outright, so the retail confirm flow resolves to
  // a typed error instead of an RPC timeout. Stock reservation now belongs to
  // the inventory-reservation capability; the whole seam is removed when that
  // capability lands. The `@Payload()` signature keeps the retail adapter's
  // compile-time contract intact (ADR-013 §7).
  @MessagePattern(ROUTING_KEYS.INVENTORY_ORDER_CONFIRM)
  public handleOrderConfirm(@Payload() payload: IProductStockOrderConfirmPayload): never {
    void payload;
    throw new RpcException(
      'inventory.order.confirm is deprecated; reservation is handled by the inventory-reservation capability',
    );
  }
}
