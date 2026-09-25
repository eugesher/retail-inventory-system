import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';

import { CartStatusEnum } from '@retail-inventory-system/contracts';
import { entityManagerOf } from '@retail-inventory-system/database';

import {
  IOrderCartReaderPort,
  IOrderCartSnapshot,
  ITransactionScope,
} from '../../application/ports';

interface ICartHeaderRow {
  id: string;
  customerId: string | null;
  currency: string;
  status: CartStatusEnum;
}
interface ICartLineRow {
  variantId: string;
  quantity: number;
}

@Injectable()
export class CartReaderTypeormAdapter implements IOrderCartReaderPort {
  constructor(
    @InjectEntityManager()
    private readonly entityManager: EntityManager,
  ) {}

  public async findCart(cartId: string): Promise<IOrderCartSnapshot | null> {
    const headerRows = await this.entityManager.query<ICartHeaderRow[]>(
      `SELECT id, customer_id AS customerId, currency, status
         FROM cart
        WHERE id = ? AND deleted_at IS NULL`,
      [cartId],
    );
    if (headerRows.length === 0) {
      return null;
    }
    const [header] = headerRows;

    const lineRows = await this.entityManager.query<ICartLineRow[]>(
      `SELECT variant_id AS variantId, quantity
         FROM cart_line
        WHERE cart_id = ? AND deleted_at IS NULL
        ORDER BY id ASC`,
      [cartId],
    );

    return {
      cartId: header.id,
      customerId: header.customerId ?? null,
      currency: header.currency,
      status: header.status,
      lines: lineRows.map((row) => ({
        variantId: Number(row.variantId),
        quantity: Number(row.quantity),
      })),
    };
  }

  public async markConverted(cartId: string, scope?: ITransactionScope): Promise<boolean> {
    const manager = scope ? entityManagerOf(scope) : this.entityManager;
    const result = await manager.query<{ affectedRows?: number }>(
      `UPDATE cart
          SET status = 'converted', version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'active'`,
      [cartId],
    );
    return Number(result?.affectedRows ?? 0) > 0;
  }
}
