import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '@retail-inventory-system/auth';
import { CartView, ICurrentUser, OrderView } from '@retail-inventory-system/contracts';
import { CorrelationId } from '@retail-inventory-system/observability';

import {
  AddToCartUseCase,
  ChangeCartLineQuantityUseCase,
  ClaimCartUseCase,
  CreateCartUseCase,
  GetCartUseCase,
  PlaceCartOrderUseCase,
  RemoveFromCartUseCase,
} from '../application/use-cases';
import {
  AddLineRequestDto,
  ChangeLineQuantityRequestDto,
  ClaimCartRequestDto,
  CreateCartRequestDto,
  PlaceOrderRequestDto,
} from './dto';

// HTTP surface over the retail microservice's six cart RPCs (ADR-009). Every
// route is bearer-protected by default (the global `JwtAuthGuard`); a customer- or
// guest-tier token passes the guard, and with no `@RequiresPermission` /`@Roles`
// the permission/role guards allow it (customers carry no permissions — ADR-024).
// The owner-check is NOT a permission code — it is the retail-side assertion
// `cart.customerId === @CurrentUser().id`: the controller folds the verified
// subject into every command, so a customer can only ever touch its own cart
// (ADR-028 §7). A non-owner gets a 403; an unauthenticated caller a 401.
//
// `cartId` is the CHAR(36) UUID (a string param, no `ParseIntPipe`); `lineId` is
// the BIGINT `cart_line.id` (a numeric param).
@ApiTags('Cart')
@ApiBearerAuth()
@Controller('cart')
export class CartController {
  constructor(
    private readonly createCartUseCase: CreateCartUseCase,
    private readonly getCartUseCase: GetCartUseCase,
    private readonly addToCartUseCase: AddToCartUseCase,
    private readonly changeCartLineQuantityUseCase: ChangeCartLineQuantityUseCase,
    private readonly removeFromCartUseCase: RemoveFromCartUseCase,
    private readonly claimCartUseCase: ClaimCartUseCase,
    private readonly placeCartOrderUseCase: PlaceCartOrderUseCase,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Open a new cart for the authenticated caller' })
  @ApiCreatedResponse({ description: 'The new cart', type: CartView })
  @ApiProduces('application/json')
  public async createCart(
    @Body() dto: CreateCartRequestDto,
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<CartView> {
    return this.createCartUseCase.execute(
      { customerId: user.id, currency: dto.currency },
      correlationId,
    );
  }

  @Get(':cartId')
  @ApiOperation({ summary: 'Read a cart by id (owner-checked)' })
  @ApiParam({ name: 'cartId', type: String, example: '11111111-1111-4111-8111-111111111111' })
  @ApiOkResponse({ description: 'The cart', type: CartView })
  @ApiProduces('application/json')
  public async getCart(
    @Param('cartId') cartId: string,
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<CartView> {
    return this.getCartUseCase.execute({ cartId, customerId: user.id }, correlationId);
  }

  @Post(':cartId/lines')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add a variant line to the cart (owner-checked)' })
  @ApiParam({ name: 'cartId', type: String, example: '11111111-1111-4111-8111-111111111111' })
  @ApiOkResponse({ description: 'The updated cart', type: CartView })
  @ApiProduces('application/json')
  public async addLine(
    @Param('cartId') cartId: string,
    @Body() dto: AddLineRequestDto,
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<CartView> {
    return this.addToCartUseCase.execute(
      { cartId, customerId: user.id, variantId: dto.variantId, quantity: dto.quantity },
      correlationId,
    );
  }

  @Patch(':cartId/lines/:lineId')
  @ApiOperation({ summary: 'Change a line quantity (owner-checked)' })
  @ApiParam({ name: 'cartId', type: String, example: '11111111-1111-4111-8111-111111111111' })
  @ApiParam({ name: 'lineId', type: Number, example: 5000 })
  @ApiOkResponse({ description: 'The updated cart', type: CartView })
  @ApiProduces('application/json')
  public async changeLineQuantity(
    @Param('cartId') cartId: string,
    @Param('lineId', ParseIntPipe) lineId: number,
    @Body() dto: ChangeLineQuantityRequestDto,
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<CartView> {
    return this.changeCartLineQuantityUseCase.execute(
      { cartId, customerId: user.id, lineId, quantity: dto.quantity },
      correlationId,
    );
  }

  @Delete(':cartId/lines/:lineId')
  @ApiOperation({ summary: 'Remove a line from the cart (owner-checked)' })
  @ApiParam({ name: 'cartId', type: String, example: '11111111-1111-4111-8111-111111111111' })
  @ApiParam({ name: 'lineId', type: Number, example: 5000 })
  @ApiOkResponse({ description: 'The updated cart', type: CartView })
  @ApiProduces('application/json')
  public async removeLine(
    @Param('cartId') cartId: string,
    @Param('lineId', ParseIntPipe) lineId: number,
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<CartView> {
    return this.removeFromCartUseCase.execute(
      { cartId, customerId: user.id, lineId },
      correlationId,
    );
  }

  @Post(':cartId/claim')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Promote a guest cart to the authenticated registered customer' })
  @ApiParam({ name: 'cartId', type: String, example: '11111111-1111-4111-8111-111111111111' })
  @ApiOkResponse({ description: 'The reassigned cart', type: CartView })
  @ApiProduces('application/json')
  public async claimCart(
    @Param('cartId') cartId: string,
    @Body() dto: ClaimCartRequestDto,
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<CartView> {
    return this.claimCartUseCase.execute(
      { cartId, fromCustomerId: dto.fromCustomerId, newCustomerId: user.id },
      correlationId,
    );
  }

  @Post(':cartId/place')
  @ApiOperation({
    summary: 'Place the cart as an order (owner-checked, authorize-on-place)',
  })
  @ApiParam({ name: 'cartId', type: String, example: '11111111-1111-4111-8111-111111111111' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Accepted + logged but not deduped (repeat-safety is via cart state)',
  })
  @ApiCreatedResponse({
    description: 'The placed order (with the authorized payment)',
    type: OrderView,
  })
  @ApiProduces('application/json')
  public async placeOrder(
    @Param('cartId') cartId: string,
    @Body() dto: PlaceOrderRequestDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: ICurrentUser,
    @CorrelationId() correlationId: string,
  ): Promise<OrderView> {
    return this.placeCartOrderUseCase.execute(
      {
        cartId,
        customerId: user.id,
        shippingAddress: dto.shippingAddress,
        billingAddress: dto.billingAddress,
        paymentMethod: dto.paymentMethod,
        idempotencyKey,
      },
      correlationId,
    );
  }
}
