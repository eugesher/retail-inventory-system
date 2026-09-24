import { ApiResponseProperty } from '@nestjs/swagger';

import {
  OrderFulfillmentStatusEnum,
  OrderLineStatusEnum,
  OrderPaymentStatusEnum,
  OrderStatusEnum,
} from '../enums';
import { PaymentView } from './payment.view';

export class OrderLineView {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public variantId: number;

  @ApiResponseProperty()
  public sku: string;

  @ApiResponseProperty()
  public nameSnapshot: string;

  @ApiResponseProperty()
  public quantity: number;

  @ApiResponseProperty()
  public cancelledQuantity: number;

  @ApiResponseProperty()
  public unitPriceMinor: number;

  @ApiResponseProperty()
  public taxAmountMinor: number;

  @ApiResponseProperty()
  public discountAmountMinor: number;

  @ApiResponseProperty()
  public lineTotalMinor: number;

  @ApiResponseProperty()
  public status: OrderLineStatusEnum;
}

export class OrderView {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public orderNumber: string;

  @ApiResponseProperty()
  public customerId: string | null;

  @ApiResponseProperty()
  public currency: string;

  @ApiResponseProperty()
  public status: OrderStatusEnum;

  @ApiResponseProperty()
  public paymentStatus: OrderPaymentStatusEnum;

  @ApiResponseProperty()
  public fulfillmentStatus: OrderFulfillmentStatusEnum;

  @ApiResponseProperty()
  public subtotalMinor: number;

  @ApiResponseProperty()
  public taxTotalMinor: number;

  @ApiResponseProperty()
  public discountTotalMinor: number;

  @ApiResponseProperty()
  public shippingTotalMinor: number;

  @ApiResponseProperty()
  public grandTotalMinor: number;

  @ApiResponseProperty()
  public billingAddressId: string | null;

  @ApiResponseProperty()
  public shippingAddressId: string | null;

  @ApiResponseProperty()
  public placedAt: string | null;

  @ApiResponseProperty()
  public version: number;

  @ApiResponseProperty({ type: [OrderLineView] })
  public lines: OrderLineView[];

  @ApiResponseProperty({ type: PaymentView })
  public payment?: PaymentView;
}
