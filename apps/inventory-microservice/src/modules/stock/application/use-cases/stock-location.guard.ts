import { InventoryDomainException, InventoryErrorCodeEnum } from '../../domain';
import { IStockRepositoryPort } from '../ports';

// Shared write-path guard: a Receive/Adjust write must target an existing,
// active stock location. Hoisted out of both write use cases (which enforced an
// identical not-found-then-inactive check) so the policy lives in one place and
// a future rule change (e.g. allowing receives into a dropship-virtual location)
// is made once.
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
