import { Address } from '../../domain';
import { ITransactionScope } from '@retail-inventory-system/ddd';

export const ADDRESS_REPOSITORY = Symbol('ADDRESS_REPOSITORY');

export interface IAddressRepositoryPort {
  save(address: Address, scope?: ITransactionScope): Promise<Address>;
}
