import { ApiResponseProperty } from '@nestjs/swagger';

// One customer's channel consent, 1:1 with the `Customer`.
//
// **The defaults are asymmetric on purpose (ADR-037).** `transactionalEmail` defaults **true** —
// an order confirmation is operationally required, not marketing. Both marketing flags default
// **false**: consent is opt-in.
//
// `updatedAt` is `null` for a customer with no stored row, which resolves to exactly those
// defaults — so a `null` here means "never chose", not "chose nothing".
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
