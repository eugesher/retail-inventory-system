import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IOrderConfirm, OrderConfirmResponseDto } from '@retail-inventory-system/contracts';

import { OrderConfirmedEvent } from '../../domain';
import {
  IInventoryConfirmGatewayPort,
  INVENTORY_CONFIRM_GATEWAY,
  IOrderEventsPublisherPort,
  IOrderRepositoryPort,
  ORDER_EVENTS_PUBLISHER,
  ORDER_REPOSITORY,
} from '../ports';

@Injectable()
export class ConfirmOrderUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY)
    private readonly repository: IOrderRepositoryPort,
    @Inject(INVENTORY_CONFIRM_GATEWAY)
    private readonly inventoryGateway: IInventoryConfirmGatewayPort,
    @Inject(ORDER_EVENTS_PUBLISHER)
    private readonly publisher: IOrderEventsPublisherPort,
    @InjectPinoLogger(ConfirmOrderUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(order: IOrderConfirm): Promise<OrderConfirmResponseDto> {
    const { id, products, correlationId } = order;

    this.logger.info(
      { correlationId, orderId: id, productCount: products.length },
      'Received RPC: confirm order',
    );

    let confirmedOrderProductIds: number[];
    try {
      confirmedOrderProductIds = await this.inventoryGateway.reserveOrderStock({
        products,
        correlationId,
      });
    } catch (error) {
      this.logger.error(
        { err: error as Error, correlationId, orderId: id },
        'Inventory order.confirm RPC failed',
      );
      throw error;
    }

    this.logger.info(
      { correlationId, orderId: id, confirmedCount: confirmedOrderProductIds.length },
      'Inventory stock confirmation received',
    );

    const aggregate = await this.repository.findById(id);
    if (!aggregate) {
      throw new Error(`Order #${id} not found after inventory confirmation`);
    }

    const result = aggregate.applyInventoryConfirmation(confirmedOrderProductIds);

    if (result.skipUpdate) {
      this.logger.debug({ correlationId, orderId: id }, 'No state update required');
      return this.readSnapshot(id);
    }

    await this.repository.confirmLines({
      orderId: id,
      newlyConfirmedProductIds: result.newlyConfirmedProductIds,
      shouldFlipHeaderToConfirmed: result.allProductsConfirmed,
      correlationId,
    });

    if (result.allProductsConfirmed) {
      this.logger.info({ correlationId, orderId: id }, 'Order fully confirmed');
    } else {
      this.logger.warn(
        {
          correlationId,
          orderId: id,
          confirmedCount: result.newlyConfirmedProductIds.length,
          totalCount: products.length,
        },
        'Order partially confirmed',
      );
    }

    for (const event of aggregate.pullDomainEvents()) {
      if (event instanceof OrderConfirmedEvent) {
        try {
          // Publish failures never raise — the order is already persisted.
          await this.publisher.publishOrderConfirmed(event, correlationId);
        } catch (err) {
          this.logger.warn(
            { err: err as Error, correlationId, orderId: id },
            'Failed to publish retail.order.confirmed event',
          );
        }
      }
    }

    return this.readSnapshot(id);
  }

  private async readSnapshot(id: number): Promise<OrderConfirmResponseDto> {
    const dto = await this.repository.findOrderResponse(id);
    if (!dto) {
      throw new Error(`Order #${id} not found after confirmation`);
    }
    return dto;
  }
}
