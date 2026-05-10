import { RoleEnum } from '@retail-inventory-system/contracts';

export class RoleVO {
  private readonly _value: RoleEnum;

  constructor(value: RoleEnum | string) {
    if (!Object.values(RoleEnum).includes(value as RoleEnum)) {
      throw new Error(`Unknown role: ${value}`);
    }
    this._value = value as RoleEnum;
  }

  public get value(): RoleEnum {
    return this._value;
  }

  public equals(other: RoleVO): boolean {
    return this._value === other._value;
  }
}
