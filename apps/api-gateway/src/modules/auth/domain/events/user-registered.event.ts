import { DomainEvent } from '@retail-inventory-system/ddd';

export class UserRegisteredEvent extends DomainEvent<string> {
  public readonly email: string;

  constructor(aggregateId: string, email: string) {
    super(aggregateId);
    this.email = email;
  }
}
