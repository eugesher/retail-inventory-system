export interface IEraseCustomerCommand {
  customerId: string;
  confirmEmail: string;
  actorStaffUserId: string | null;
  correlationId: string;
}
