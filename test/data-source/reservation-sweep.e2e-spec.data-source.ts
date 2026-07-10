import { InventoryAutoInitE2ESpecDataSource } from './inventory-auto-init.e2e-spec.data-source';

// One `reservation` row, projected to the fields the sweeper suites assert on. The
// hold's whole lifecycle is its `status`; `version` is the optimistic token every
// mutator bumps, so an advanced version is the proof that `expire()` (and not merely
// a re-read) touched the row.
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

// One `stock_movement` row. The ledger is where an operator sweep and a timer tick
// become distinguishable after the fact: both append `type = 'release'` with
// `reason_code = 'expired'`, but only the operator's carries an `actor_id`.
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

// One `stock_level` row. `available` is a pure getter on the aggregate, never a column,
// so the suites derive it the same way the domain does: `on_hand - allocated - reserved`.
export interface IStockLevelRowProjection {
  variantId: number;
  stockLocationId: string;
  quantityOnHand: number;
  quantityAllocated: number;
  quantityReserved: number;
  version: number;
}

// E2E helper for the three reservation-sweeper suites. Inherits `getStockLevelRows`
// (the auto-init poll every stock-provisioning suite needs) and adds direct reads over
// the three tables the sweep touches, plus the one write no production API offers.
//
// **The connection MUST be opened with `timezone: 'Z'`**, matching the app's
// `DatabaseModule`. `reservation.expires_at` is a MySQL `TIMESTAMP`, and the sweep's
// candidate scan binds a JS `Date` as its `now`. If this connection serialized its own
// `Date` in the Node host's local zone while the app read it back as UTC, the ageing
// write below would land at the wrong instant and the sweep would silently miss the row
// (or catch a hold that is still live) — the `IdempotencyE2ESpecDataSource` precedent.
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

  // ─────────────────────────────────────────────────────────────────────────────
  // THE TEST-ONLY ESCAPE HATCH. Read this before using it.
  //
  // There is deliberately NO production API that expires a hold on demand: a hold is
  // stale because wall-clock time passed it, and letting an operator forge that would
  // hand them a way to yank a live shopper's stock out from under a checkout. The
  // reclaim path (`SweepExpiredReservationsUseCase`) reads `expires_at`; it does not
  // take one.
  //
  // So a suite that wants to observe the reclaim has exactly two options: wait out
  // `RESERVATION_TTL_MINUTES` (15 minutes, per hold), or reach past the domain and age
  // the row in the database. This method is the second. It writes ONE column of ONE row
  // by primary key, and nothing else in the system does.
  //
  // Pair it with a connection pinned to `timezone: 'Z'` (see the class header) — a
  // double timezone shift here moves the horizon by the host's UTC offset and the sweep
  // sees a hold that is still live.
  // ─────────────────────────────────────────────────────────────────────────────
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

  // Every ledger row this cart caused for this variant, oldest first. The
  // `(reference_type, reference_id)` pair is the polymorphic, FK-less link a release
  // writes back to the cart that held the units.
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
