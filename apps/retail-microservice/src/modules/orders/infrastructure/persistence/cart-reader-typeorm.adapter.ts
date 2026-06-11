import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';

import { CartStatusEnum } from '@retail-inventory-system/contracts';

import {
  IOrderCartReaderPort,
  IOrderCartSnapshot,
  ITransactionScope,
} from '../../application/ports';

// The mysql2 row shapes for the two cart reads. Aliasing the snake_case columns to
// camelCase keeps the projection mapping off `any` without an assertion (ADR-017's
// no-unsafe-* rules); BIGINT columns surface as strings, so the mapper coerces.
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

// The orders context's read/convert seam onto the **cart** tables. The cart is a
// sibling module behind a hard isolation line — the boundaries lint forbids the
// orders module from importing the cart module's `CartEntity` / `ICartRepositoryPort`
// (ADR-017). So this adapter reaches the `cart` / `cart_line` tables with
// PARAMETERIZED SQL through the injected `EntityManager`, exactly as pricing reaches
// the catalog-owned `product_variant.tax_category_id` (ADR-026 §5). The opaque shared
// FK (`cart.id`) is the only coupling; the `?` placeholders are bound by the driver,
// never string-concatenated.
//
// `cart_line` carries `deleted_at` (the `BaseEntity` soft-delete column, kept inert);
// both reads filter `deleted_at IS NULL` for parity with TypeORM's default scope.
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
    // Run on the place transaction's manager when a scope is supplied (the convert
    // commits atomically with the order + address writes); else the default manager.
    // `version = version + 1` keeps the cart's optimistic-concurrency token advancing
    // on this mutation for parity with the domain bump (the column ships, the guard
    // is a later capability — ADR-028 §6).
    //
    // `WHERE status = 'active'` is the compare-and-swap that serializes racing
    // places: the InnoDB row lock blocks the second UPDATE until the first place
    // commits, after which it matches 0 rows. The returned boolean surfaces that
    // (`affectedRows` is reliable here — the SET always changes a matched row), so
    // the caller can roll back instead of committing a duplicate order.
    const manager = scope ? (scope as unknown as EntityManager) : this.entityManager;
    const result = await manager.query<{ affectedRows?: number }>(
      `UPDATE cart
          SET status = 'converted', version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'active'`,
      [cartId],
    );
    return Number(result?.affectedRows ?? 0) > 0;
  }
}
