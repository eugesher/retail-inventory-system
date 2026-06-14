import {
  IAllocationLine,
  INVENTORY_DEFAULT_STOCK_LOCATION,
} from '@retail-inventory-system/contracts';

import { InventoryDomainException, InventoryErrorCodeEnum, StockLevel } from '../../domain';
import { IStockRepositoryPort, ITransactionScope } from '../ports';

const MS_PER_MINUTE = 60_000;

// A request line normalized at the edge — the optional location resolved to the
// default. Shared by the all-lines-atomic order-side use cases (Allocate / Cancel).
export interface INormalizedReservationLine {
  variantId: number;
  stockLocationId: string;
  quantity: number;
}

// A distinct `(variantId, stockLocationId)` level loaded once per attempt, with the
// optimistic token captured BEFORE any mutation. Several lines may share it.
export interface ILoadedStockLevel {
  level: StockLevel;
  expectedVersion: number | null;
}

// The map key for a `(variantId, stockLocationId)` pair — lines sharing a level
// resolve to the same entry so it is loaded and persisted exactly once per attempt.
export function levelKey(variantId: number, stockLocationId: string): string {
  return `${variantId}:${stockLocationId}`;
}

// The TTL expiry instant for a reservation (`now + ttlMinutes`), shared by Reserve
// (mint / refresh) and Allocate (refresh-then-commit of a wall-clock-stale hold).
export function reservationExpiresAt(now: Date, ttlMinutes: number): Date {
  return new Date(now.getTime() + ttlMinutes * MS_PER_MINUTE);
}

// Backstop for the directly-reachable RMQ path (the gateway DTO validates first):
// a non-empty line list, each with a positive-integer quantity, the optional
// location resolved to the default. `label` prefixes the rejection message so the
// caller sees which operation rejected (e.g. `Allocate` / `Cancel allocation`).
export function normalizeReservationLines(
  lines: IAllocationLine[] | undefined,
  label: string,
): INormalizedReservationLine[] {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new InventoryDomainException(
      InventoryErrorCodeEnum.RESERVATION_QUANTITY_INVALID,
      `${label} requires a non-empty lines array`,
    );
  }

  return lines.map((line) => {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.RESERVATION_QUANTITY_INVALID,
        `${label} line quantity must be a positive integer, got ${line.quantity}`,
      );
    }
    return {
      variantId: line.variantId,
      stockLocationId: line.stockLocationId ?? INVENTORY_DEFAULT_STOCK_LOCATION,
      quantity: line.quantity,
    };
  });
}

// Phase 1 of an all-lines-atomic write: load each distinct `(variantId, location)`
// level exactly once and capture its optimistic token before any counter moves, so
// lines sharing a level mutate the one in-memory instance and it persists with a
// single version bump. A missing row lazy-inits to a zeroed level (token null marks
// the first-touch INSERT).
export async function loadDistinctLevels(
  repository: IStockRepositoryPort,
  lines: INormalizedReservationLine[],
  scope: ITransactionScope,
): Promise<Map<string, ILoadedStockLevel>> {
  const levels = new Map<string, ILoadedStockLevel>();
  for (const line of lines) {
    const key = levelKey(line.variantId, line.stockLocationId);
    if (!levels.has(key)) {
      const existing = await repository.findStockLevel(line.variantId, line.stockLocationId, scope);
      levels.set(key, {
        level: existing ?? StockLevel.initialAt(line.variantId, line.stockLocationId),
        expectedVersion: existing ? existing.version : null,
      });
    }
  }
  return levels;
}
