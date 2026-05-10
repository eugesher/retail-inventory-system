import { ICurrentUser, IJwtAccessPayload } from '@retail-inventory-system/contracts';

export const AUTH_USER_VALIDATOR = Symbol('AUTH_USER_VALIDATOR');

// Apps wire a binding for this token under their own auth module so the
// shared `JwtStrategy` can resolve a request user without knowing how the
// app stores or revokes accounts.
export interface IAuthUserValidator {
  validate(payload: IJwtAccessPayload): Promise<ICurrentUser>;
}
