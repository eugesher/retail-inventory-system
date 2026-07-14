import { InventoryDomainException, InventoryErrorCodeEnum } from '../../domain';
import { IStockRepositoryPort } from '../ports';

// The shared write-path guard: **every** stock write must target a location that exists and is
// active. One policy in one place — a transfer runs it twice, once per leg.
//
// The order matters: not-found is checked before inactive, so naming a location that never existed
// and naming one that was deactivated give a caller different answers.
export const requireActiveLocation = async (
  repository: IStockRepositoryPort,
  stockLocationId: string,
): Promise<void> => {
  const location = await repository.findLocation(stockLocationId);
  if (location === null) {
    throw new InventoryDomainException(
      InventoryErrorCodeEnum.STOCK_LOCATION_NOT_FOUND,
      `Stock location '${stockLocationId}' does not exist`,
    );
  }
  if (!location.active) {
    throw new InventoryDomainException(
      InventoryErrorCodeEnum.STOCK_LOCATION_INACTIVE,
      `Stock location '${stockLocationId}' is deactivated`,
    );
  }
};
