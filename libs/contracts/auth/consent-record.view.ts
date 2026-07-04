import { ApiResponseProperty } from '@nestjs/swagger';

// The wire/response shape of one customer's channel-consent record. A **class**
// carrying `@ApiResponseProperty` (the documented lib-contracts Swagger
// exception, ADR-017), matching the `*View` convention (`OrderView`,
// `NotificationDeliveryView`) so a later consent Read endpoint can document it.
//
// A `ConsentRecord` is 1:1 with a Customer, keyed on the customer's CHAR(36)
// UUID. `transactionalEmail` defaults true (order-confirmation-style mail is
// operationally required); the two marketing flags default false (opt-in — the
// GDPR posture). `dataRetentionPolicy` is a free-form policy label
// (`default-7-years`). `updatedAt` is the ISO-8601 timestamp of the last write,
// or null for a customer with no stored row (which resolves to the defaults).
export class ConsentRecordView {
  @ApiResponseProperty()
  public customerId: string;

  @ApiResponseProperty()
  public transactionalEmail: boolean;

  @ApiResponseProperty()
  public marketingEmail: boolean;

  @ApiResponseProperty()
  public marketingSms: boolean;

  @ApiResponseProperty()
  public dataRetentionPolicy: string;

  @ApiResponseProperty()
  public updatedAt: string | null;
}
