import { ApiResponseProperty } from '@nestjs/swagger';

export class ReservationView {
  @ApiResponseProperty()
  public reservationId: string;

  @ApiResponseProperty()
  public variantId: number;

  @ApiResponseProperty()
  public stockLocationId: string;

  @ApiResponseProperty()
  public quantity: number;

  @ApiResponseProperty()
  public cartId: string;

  @ApiResponseProperty()
  public expiresAt: string;

  @ApiResponseProperty()
  public status: 'active' | 'committed' | 'released' | 'expired';
}
