export interface IRecordConsentCommand {
  customerId: string;
  transactionalEmail?: boolean;
  marketingEmail?: boolean;
  marketingSms?: boolean;
  dataRetentionPolicy?: string;
  correlationId: string;
}
