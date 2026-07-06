// The input to `EraseCustomerUseCase`. `customerId` is the customer to erase (the
// admin route's path param). `confirmEmail` is the operator-typed current email — a
// deliberate guard against an accidental irreversible erase (checked
// case-insensitively against the live customer's email). `actorStaffUserId` is the
// erasing staff principal (folded from `@CurrentUser().id`), recorded in the audit
// row + the `customer.erased` event — never `null` on the admin route, but typed
// nullable to match the audit/event contracts (a system-origin erase carries null).
export interface IEraseCustomerCommand {
  customerId: string;
  confirmEmail: string;
  actorStaffUserId: string | null;
  correlationId: string;
}
