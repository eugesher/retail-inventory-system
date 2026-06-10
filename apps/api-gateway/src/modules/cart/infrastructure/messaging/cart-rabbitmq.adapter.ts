import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  CartView,
  IPlaceOrderPayload,
  IRetailCartAddLinePayload,
  IRetailCartChangeLineQuantityPayload,
  IRetailCartClaimPayload,
  IRetailCartCreatePayload,
  IRetailCartGetPayload,
  IRetailCartRemoveLinePayload,
  OrderView,
} from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import {
  ICartAddLineCommand,
  ICartChangeLineQuantityCommand,
  ICartClaimCommand,
  ICartCreateCommand,
  ICartGatewayPort,
  ICartGetQuery,
  ICartPlaceCommand,
  ICartRemoveLineCommand,
} from '../../application/ports';

// The single `ClientProxy` holder for the gateway cart module (ADR-009 /
// ADR-020). Each method materializes the RPC with `firstValueFrom` and stitches
// the transport-level `correlationId` onto the wire payload; everything else in
// the module depends on `ICartGatewayPort`, never on `@nestjs/microservices`. All
// six RPCs target `retail_queue` via the `RETAIL_MICROSERVICE` client.
@Injectable()
export class CartRabbitmqAdapter implements ICartGatewayPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.RETAIL_MICROSERVICE)
    private readonly client: ClientProxy,
  ) {}

  public async createCart(command: ICartCreateCommand, correlationId: string): Promise<CartView> {
    return firstValueFrom(
      this.client.send<CartView, IRetailCartCreatePayload>(ROUTING_KEYS.RETAIL_CART_CREATE, {
        ...command,
        correlationId,
      }),
    );
  }

  public async getCart(query: ICartGetQuery, correlationId: string): Promise<CartView> {
    return firstValueFrom(
      this.client.send<CartView, IRetailCartGetPayload>(ROUTING_KEYS.RETAIL_CART_GET, {
        ...query,
        correlationId,
      }),
    );
  }

  public async addLine(command: ICartAddLineCommand, correlationId: string): Promise<CartView> {
    return firstValueFrom(
      this.client.send<CartView, IRetailCartAddLinePayload>(ROUTING_KEYS.RETAIL_CART_ADD_LINE, {
        ...command,
        correlationId,
      }),
    );
  }

  public async changeLineQuantity(
    command: ICartChangeLineQuantityCommand,
    correlationId: string,
  ): Promise<CartView> {
    return firstValueFrom(
      this.client.send<CartView, IRetailCartChangeLineQuantityPayload>(
        ROUTING_KEYS.RETAIL_CART_CHANGE_LINE_QUANTITY,
        { ...command, correlationId },
      ),
    );
  }

  public async removeLine(
    command: ICartRemoveLineCommand,
    correlationId: string,
  ): Promise<CartView> {
    return firstValueFrom(
      this.client.send<CartView, IRetailCartRemoveLinePayload>(
        ROUTING_KEYS.RETAIL_CART_REMOVE_LINE,
        { ...command, correlationId },
      ),
    );
  }

  public async claim(command: ICartClaimCommand, correlationId: string): Promise<CartView> {
    return firstValueFrom(
      this.client.send<CartView, IRetailCartClaimPayload>(ROUTING_KEYS.RETAIL_CART_CLAIM, {
        ...command,
        correlationId,
      }),
    );
  }

  public async placeOrder(command: ICartPlaceCommand, correlationId: string): Promise<OrderView> {
    return firstValueFrom(
      this.client.send<OrderView, IPlaceOrderPayload>(ROUTING_KEYS.RETAIL_CART_PLACE, {
        ...command,
        correlationId,
      }),
    );
  }
}
