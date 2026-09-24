import { InventoryDomainException, InventoryErrorCodeEnum } from '../../domain';
import { IStockRepositoryPort } from '../ports';

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
