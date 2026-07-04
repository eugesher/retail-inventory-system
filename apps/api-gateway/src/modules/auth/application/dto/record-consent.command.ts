// The input to `RecordConsentUseCase`. `customerId` is ALWAYS the authenticated
// caller's id (folded at the controller from `@CurrentUser().id`) — there is no
// cross-customer write. The four channel/policy fields are optional: only the
// supplied keys are overlaid onto the existing (or default) record — the
// upsert-merge `ConsentRecord.apply(partial)` semantics (a customer PATCHing just
// `marketingEmail` leaves the other three untouched).
export interface IRecordConsentCommand {
  customerId: string;
  transactionalEmail?: boolean;
  marketingEmail?: boolean;
  marketingSms?: boolean;
  dataRetentionPolicy?: string;
  correlationId: string;
}
