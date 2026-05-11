export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');

export interface IPasswordPort {
  hash(plain: string): Promise<string>;
  verify(hash: string, plain: string): Promise<boolean>;
}
