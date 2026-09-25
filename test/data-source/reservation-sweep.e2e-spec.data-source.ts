import { InventoryAutoInitE2ESpecDataSource } from './inventory-auto-init.e2e-spec.data-source';

export interface IReservationRowProjection {
  id: string;
  variantId: number;
  stockLocationId: string;
  quantity: number;
  cartId: string;
  expiresAt: Date;
  status: string;
  version: number;
}

export interface IStockMovementRowProjection {
  id: number;
  variantId: number;
  stockLocationId: string;
  type: string;
  quantity: number;
  reasonCode: string | null;
  referenceType: string | null;
  referenceId: string | null;
  actorId: string | null;
  occurredAt: Date;
}

export interface IStockLevelRowProjection {
  variantId: number;
  stockLocationId: string;
  quantityOnHand: number;
  quantityAllocated: number;
  quantityReserved: number;
  version: number;
}

export class ReservationSweepE2ESpecDataSource extends InventoryAutoInitE2ESpecDataSource {
  private static readonly RESERVATION_COLUMNS = `
    id, variant_id, stock_location_id, quantity, cart_id, expires_at, status, version
  `;

  private static toReservationRow(row: Record<string, unknown>): IReservationRowProjection {
    return {
      id: String(row.id),
      variantId: Number(row.variant_id),
      stockLocationId: String(row.stock_location_id),
      quantity: Number(row.quantity),
      cartId: String(row.cart_id),
      expiresAt: row.expires_at as Date,
      status: String(row.status),
      version: Number(row.version),
    };
  }

  public async getReservationsByCartId(cartId: string): Promise<IReservationRowProjection[]> {
    const rows: Record<string, unknown>[] = await this.query(
      `
        SELECT ${ReservationSweepE2ESpecDataSource.RESERVATION_COLUMNS}
        FROM reservation
        WHERE cart_id = ?
        ORDER BY id;
      `,
      [cartId],
    );
    return rows.map((row) => ReservationSweepE2ESpecDataSource.toReservationRow(row));
  }

  public async getReservationById(id: string): Promise<IReservationRowProjection | undefined> {
    const rows: Record<string, unknown>[] = await this.query(
      `
        SELECT ${ReservationSweepE2ESpecDataSource.RESERVATION_COLUMNS}
        FROM reservation
        WHERE id = ?
        LIMIT 1;
      `,
      [id],
    );
    const row = rows[0];
    return row === undefined ? undefined : ReservationSweepE2ESpecDataSource.toReservationRow(row);
  }

  public async ageReservation(id: string, expiresAt: Date): Promise<void> {
    await this.query(`UPDATE reservation SET expires_at = ? WHERE id = ?;`, [expiresAt, id]);
  }

  public async getStockLevel(
    variantId: number,
    stockLocationId: string,
  ): Promise<IStockLevelRowProjection | undefined> {
    const rows: Record<string, unknown>[] = await this.query(
      `
        SELECT variant_id, stock_location_id, quantity_on_hand,
               quantity_allocated, quantity_reserved, version
        FROM stock_level
        WHERE variant_id = ? AND stock_location_id = ?
        LIMIT 1;
      `,
      [variantId, stockLocationId],
    );
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    return {
      variantId: Number(row.variant_id),
      stockLocationId: String(row.stock_location_id),
      quantityOnHand: Number(row.quantity_on_hand),
      quantityAllocated: Number(row.quantity_allocated),
      quantityReserved: Number(row.quantity_reserved),
      version: Number(row.version),
    };
  }

  public async getMovementsByCartAndVariant(
    cartId: string,
    variantId: number,
  ): Promise<IStockMovementRowProjection[]> {
    const rows: Record<string, unknown>[] = await this.query(
      `
        SELECT id, variant_id, stock_location_id, type, quantity, reason_code,
               reference_type, reference_id, actor_id, occurred_at
        FROM stock_movement
        WHERE reference_type = 'cart' AND reference_id = ? AND variant_id = ?
        ORDER BY id ASC;
      `,
      [cartId, variantId],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      variantId: Number(row.variant_id),
      stockLocationId: String(row.stock_location_id),
      type: String(row.type),
      quantity: Number(row.quantity),
      reasonCode: (row.reason_code as string | null) ?? null,
      referenceType: (row.reference_type as string | null) ?? null,
      referenceId: (row.reference_id as string | null) ?? null,
      actorId: (row.actor_id as string | null) ?? null,
      occurredAt: row.occurred_at as Date,
    }));
  }
}
