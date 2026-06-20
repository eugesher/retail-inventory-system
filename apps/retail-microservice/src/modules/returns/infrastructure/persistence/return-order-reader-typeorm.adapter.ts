import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';

import { OrderFulfillmentStatusEnum, OrderStatusEnum } from '@retail-inventory-system/contracts';

import { IReturnOrderReaderPort, IReturnOrderSnapshot } from '../../application/ports';

// The mysql2 row shapes for the two order reads. Aliasing the snake_case columns to
// camelCase keeps the projection mapping off `any` without an assertion (ADR-017's
// no-unsafe-* rules); BIGINT columns surface as strings, so the mapper coerces.
interface IOrderHeaderRow {
  id: string;
  customerId: string | null;
  status: OrderStatusEnum;
  fulfillmentStatus: OrderFulfillmentStatusEnum;
  // MIN/MAX of a TIMESTAMP column — mysql2 returns it as a Date (the driver is pinned to
  // UTC), or null when the order has no shipped/delivered fulfillment.
  shippedAt: Date | string | null;
  deliveredAt: Date | string | null;
}
interface IOrderLineRow {
  orderLineId: string;
  variantId: string;
  quantity: number;
  status: string;
}

// The returns context's read seam onto the **order** tables. The orders module is a
// sibling behind a hard isolation line — the boundaries lint forbids the returns module
// from importing the orders module's `OrderEntity` / `IOrderRepositoryPort` (ADR-017). So
// this adapter reaches the `order` / `order_line` / `fulfillment` tables with PARAMETERIZED
// SQL through the injected `EntityManager`, exactly as the orders module reaches the cart
// tables via `CartReaderTypeormAdapter` (ADR-028) and pricing reaches the catalog-owned
// `product_variant.tax_category_id` (ADR-026 §5). The opaque shared FKs (`order.id`,
// `order_line.order_id`) are the only coupling; the `?` placeholders are bound by the
// driver, never string-concatenated.
//
// `order` is a SQL reserved word, so it is backticked in every query. Every table carries
// `deleted_at` (the `BaseEntity` soft-delete column, kept inert); the reads filter
// `deleted_at IS NULL` for parity with TypeORM's default scope. The `shipped_at` /
// `delivered_at` window timestamps are rolled up from the order's `fulfillment` rows
// (`MIN(shipped_at)` — the first ship, `MAX(delivered_at)` — the last delivery).
@Injectable()
export class ReturnOrderReaderTypeormAdapter implements IReturnOrderReaderPort {
  constructor(
    @InjectEntityManager()
    private readonly entityManager: EntityManager,
  ) {}

  public async findOrderForReturn(orderId: number): Promise<IReturnOrderSnapshot | null> {
    const headerRows = await this.entityManager.query<IOrderHeaderRow[]>(
      `SELECT o.id,
              o.customer_id AS customerId,
              o.status,
              o.fulfillment_status AS fulfillmentStatus,
              (SELECT MIN(f.shipped_at)
                 FROM fulfillment f
                WHERE f.order_id = o.id
                  AND f.shipped_at IS NOT NULL
                  AND f.deleted_at IS NULL) AS shippedAt,
              (SELECT MAX(f.delivered_at)
                 FROM fulfillment f
                WHERE f.order_id = o.id
                  AND f.delivered_at IS NOT NULL
                  AND f.deleted_at IS NULL) AS deliveredAt
         FROM \`order\` o
        WHERE o.id = ? AND o.deleted_at IS NULL`,
      [orderId],
    );
    if (headerRows.length === 0) {
      return null;
    }
    const [header] = headerRows;

    const lineRows = await this.entityManager.query<IOrderLineRow[]>(
      `SELECT id AS orderLineId, variant_id AS variantId, quantity, status
         FROM order_line
        WHERE order_id = ? AND deleted_at IS NULL
        ORDER BY id ASC`,
      [orderId],
    );

    return {
      orderId: Number(header.id),
      customerId: header.customerId ?? null,
      status: header.status,
      fulfillmentStatus: header.fulfillmentStatus,
      shippedAt: ReturnOrderReaderTypeormAdapter.toDate(header.shippedAt),
      deliveredAt: ReturnOrderReaderTypeormAdapter.toDate(header.deliveredAt),
      lines: lineRows.map((row) => ({
        orderLineId: Number(row.orderLineId),
        variantId: Number(row.variantId),
        quantity: Number(row.quantity),
        // No per-line `cancelled_quantity` column exists; a whole line cancelled to the
        // `cancelled` status removes its full ordered quantity from the returnable pool.
        // Partial-quantity line cancellation is not persisted (Cancel Line only releases
        // the allocation), so it cannot be read back here (a documented limitation).
        cancelledQuantity: row.status === 'cancelled' ? Number(row.quantity) : 0,
      })),
    };
  }

  // Normalizes a TIMESTAMP roll-up to a `Date | null`. mysql2 returns a `Date` for a
  // TIMESTAMP column, but a MIN/MAX aggregate can surface as a string on some driver
  // configurations — `new Date(...)` handles both; `null` stays `null`.
  private static toDate(value: Date | string | null): Date | null {
    if (value === null || value === undefined) {
      return null;
    }
    return value instanceof Date ? value : new Date(value);
  }
}
