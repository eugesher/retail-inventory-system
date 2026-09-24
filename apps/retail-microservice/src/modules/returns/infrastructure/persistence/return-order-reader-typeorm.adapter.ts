import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';

import { OrderFulfillmentStatusEnum, OrderStatusEnum } from '@retail-inventory-system/contracts';

import { IReturnOrderReaderPort, IReturnOrderSnapshot } from '../../application/ports';

interface IOrderHeaderRow {
  id: string;
  customerId: string | null;
  status: OrderStatusEnum;
  fulfillmentStatus: OrderFulfillmentStatusEnum;
  shippedAt: Date | string | null;
  deliveredAt: Date | string | null;
}
interface IOrderLineRow {
  orderLineId: string;
  variantId: string;
  quantity: number;
  cancelledQuantity: number;
  status: string;
}

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
      `SELECT id AS orderLineId, variant_id AS variantId, quantity,
              cancelled_quantity AS cancelledQuantity, status
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
        cancelledQuantity: Number(row.cancelledQuantity),
      })),
    };
  }

  private static toDate(value: Date | string | null): Date | null {
    if (value === null || value === undefined) {
      return null;
    }
    return value instanceof Date ? value : new Date(value);
  }
}
