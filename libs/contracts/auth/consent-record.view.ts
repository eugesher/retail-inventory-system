import { ApiResponseProperty } from '@nestjs/swagger';

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
