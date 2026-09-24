import { ICurrentUser, IJwtAccessPayload } from '@retail-inventory-system/contracts';

export const AUTH_USER_VALIDATOR = Symbol('AUTH_USER_VALIDATOR');

export interface IAuthUserValidator {
  validate(payload: IJwtAccessPayload): Promise<ICurrentUser>;
}
