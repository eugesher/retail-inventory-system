import {
  IAllocationLine,
  INVENTORY_DEFAULT_STOCK_LOCATION,
} from '@retail-inventory-system/contracts';

import { InventoryDomainException, InventoryErrorCodeEnum, StockLevel } from '../../domain';
import { IStockRepositoryPort, ITransactionScope } from '../ports';

const MS_PER_MINUTE = 60_000;

export interface INormalizedReservationLine {
  variantId: number;
  stockLocationId: string;
  quantity: number;
}

export interface ILoadedStockLevel {
  level: StockLevel;
  expectedVersion: number | null;
}

export function levelKey(variantId: number, stockLocationId: string): string {
  return `${variantId}:${stockLocationId}`;
}

export function reservationExpiresAt(now: Date, ttlMinutes: number): Date {
  return new Date(now.getTime() + ttlMinutes * MS_PER_MINUTE);
}

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

export function requireDistinctLevels(lines: INormalizedReservationLine[], label: string): void {
  const seen = new Set<string>();
  for (const line of lines) {
    const key = levelKey(line.variantId, line.stockLocationId);
    if (seen.has(key)) {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.RESERVATION_QUANTITY_INVALID,
        `${label} requires one line per (variant, location); variant ${line.variantId} @ ` +
          `${line.stockLocationId} appears twice — merge the lines and resend`,
      );
    }
    seen.add(key);
  }
}

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
