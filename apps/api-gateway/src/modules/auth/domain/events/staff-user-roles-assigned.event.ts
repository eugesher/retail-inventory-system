import { DomainEvent } from '@retail-inventory-system/ddd';

export class StaffUserRolesAssignedEvent extends DomainEvent<string> {
  public readonly assignedRoleNames: readonly string[];

  constructor(aggregateId: string, assignedRoleNames: readonly string[]) {
    super(aggregateId);
    this.assignedRoleNames = [...assignedRoleNames];
  }
}
