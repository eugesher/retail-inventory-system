import { DomainEvent } from '@retail-inventory-system/ddd';

export class StaffUserRoleRevokedEvent extends DomainEvent<string> {
  public readonly revokedRoleName: string;

  constructor(aggregateId: string, revokedRoleName: string) {
    super(aggregateId);
    this.revokedRoleName = revokedRoleName;
  }
}
