import { randomUUID } from 'crypto';

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DeepPartial, EntityManager, Repository } from 'typeorm';

import { BaseTypeormRepository } from '@retail-inventory-system/database';

import { Order } from '../../domain';
import {
  IOrderPage,
  IOrderPageRequest,
  IOrderRepositoryPort,
  ITransactionScope,
} from '../../application/ports';
import { OrderEntity } from './order.entity';
import { OrderLineEntity } from './order-line.entity';
import { OrderLineMapper } from './order-line.mapper';
import { OrderMapper } from './order.mapper';

// The single `@InjectRepository` site for the order context. Extends
// `BaseTypeormRepository` for the `toDomain`/`toEntity` seam over the `Order`
// aggregate; `save` is overridden because the root + its lines persist explicitly
// inside one transaction and the human-facing `order_number` is finalized from the
// generated id (the "re-read the saved graph, then finalize a derived field"
// idiom). Returns domain types only — no TypeORM leak past this file (ADR-017).
//
// `save` / `findById` / `attachAddresses` accept an optional `ITransactionScope`:
// Place Order hands the same scope to the order, address, and cart-conversion writes
// so they commit as one unit of work (ADR-017 §6 / ADR-028 §5). The
// `EntityManager` downcast that unwraps the brand lives only in `scopedManager`
// (the place ADR-017 §6 permits it).
@Injectable()
export class OrderTypeormRepository
  extends BaseTypeormRepository<OrderEntity, Order>
  implements IOrderRepositoryPort
{
  constructor(
    @InjectRepository(OrderEntity)
    private readonly orderRepository: Repository<OrderEntity>,
    @InjectRepository(OrderLineEntity)
    private readonly orderLineRepository: Repository<OrderLineEntity>,
    @InjectPinoLogger(OrderTypeormRepository.name)
    private readonly logger: PinoLogger,
  ) {
    super(orderRepository);
  }

  protected toDomain(entity: OrderEntity): Order {
    return OrderMapper.toDomain(entity);
  }

  protected toEntity(domain: Order): DeepPartial<OrderEntity> {
    return OrderMapper.toEntity(domain);
  }

  public async findById(id: number, scope?: ITransactionScope): Promise<Order | null> {
    const entity = await this.orderRepo(scope).findOne({
      where: { id },
      relations: { lines: true },
      // Deterministic line order so the view is stable across reads.
      order: { lines: { id: 'ASC' } },
    });
    return entity ? OrderMapper.toDomain(entity) : null;
  }

  // Repeat-place idempotency seam (the place capability): a cart that already
  // converted resolves to the order it converted into. Returns the most recent
  // match defensively, though a converted cart maps to exactly one order.
  public async findBySourceCartId(cartId: string): Promise<Order | null> {
    const entity = await this.orderRepository.findOne({
      where: { sourceCartId: cartId },
      relations: { lines: true },
      order: { id: 'DESC', lines: { id: 'ASC' } },
    });
    return entity ? OrderMapper.toDomain(entity) : null;
  }

  // The customer's order history (owner-checked at the use case, ADR-028 §7).
  // Newest first; one page of orders with their lines.
  public async listByCustomer(customerId: string, page: IOrderPageRequest): Promise<IOrderPage> {
    const [entities, total] = await this.orderRepository.findAndCount({
      where: { customerId },
      relations: { lines: true },
      order: { placedAt: 'DESC', id: 'DESC', lines: { id: 'ASC' } },
      skip: (page.page - 1) * page.size,
      take: page.size,
    });
    return {
      items: entities.map((entity) => OrderMapper.toDomain(entity)),
      total,
      page: page.page,
      size: page.size,
    };
  }

  // Walking-skeleton order numbering: formats the next human-facing number from the
  // current max id. The **binding** value is finalized inside `save` from the
  // order's real generated id (so it always matches the row), making this a
  // non-binding preview; a dedicated monotonic sequence is a later refinement. The
  // year segment uses the current UTC year.
  public async nextOrderNumber(): Promise<string> {
    const row = await this.orderRepository
      .createQueryBuilder('o')
      .select('MAX(o.id)', 'maxId')
      .getRawOne<{ maxId: string | null }>();
    const nextId = (row?.maxId ? Number(row.maxId) : 0) + 1;
    return OrderTypeormRepository.formatOrderNumber(new Date().getUTCFullYear(), nextId);
  }

  public async save(order: Order, scope?: ITransactionScope): Promise<Order> {
    // One transaction for the root + its lines: a half-written graph (the header
    // committed but a line missing) would corrupt the totals the order view reports.
    // When the caller already owns a transaction (`scope`), join it — the place flow
    // commits the order, addresses, and cart conversion atomically — else open one.
    let orderId: number;
    if (scope) {
      orderId = await this.persistGraph(scope as unknown as EntityManager, order);
    } else {
      orderId = await this.orderRepository.manager.transaction((manager) =>
        this.persistGraph(manager, order),
      );
    }

    // Re-read the full graph (within the same scope when transactional) so the
    // returned aggregate carries the concrete generated `order_line.id`s, the
    // finalized `order_number`, the committed version, and the DB timestamps. The
    // row was just written, so a miss is an invariant breach.
    const reloaded = await this.findById(orderId, scope);
    if (!reloaded) {
      throw new Error(`OrderTypeormRepository.save: order ${orderId} vanished after commit`);
    }
    return reloaded;
  }

  // Finalizes the two snapshot-address FK columns once both `address` rows exist
  // (the order was inserted with NULL address ids — they FK onto `address`, so the
  // rows must precede the pointer). A targeted UPDATE, the same "finalize a derived
  // column after the row is written" idiom `order_number` uses; it does not advance
  // `@VersionColumn` (a persistence-finalization detail, not a domain mutation).
  public async attachAddresses(
    orderId: number,
    billingAddressId: string,
    shippingAddressId: string,
    scope?: ITransactionScope,
  ): Promise<void> {
    await this.orderRepo(scope).update({ id: orderId }, { billingAddressId, shippingAddressId });
  }

  // Persists the root + its lines on the given manager and returns the order id.
  // On a NEW order (`id===null`) the first insert needs a non-null UNIQUE
  // `order_number`, but the binding value derives from the not-yet-assigned id — so
  // insert with a guaranteed-unique provisional token, read the generated id, then
  // finalize the real number and UPDATE. The provisional never commits (it is
  // overwritten before the transaction closes). On a re-save (a payment-status /
  // version bump) `order_number` is immutable and the lines never change, so update
  // the root without touching `order_number`.
  private async persistGraph(manager: EntityManager, order: Order): Promise<number> {
    const orderRepo = manager.getRepository(OrderEntity);
    const lineRepo = manager.getRepository(OrderLineEntity);

    if (order.id === null) {
      const rootPartial = OrderMapper.toEntity(order);
      rootPartial.orderNumber = `TMP-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const inserted = await orderRepo.save(rootPartial);
      const newId = Number(inserted.id);

      const year = (order.placedAt ?? new Date()).getUTCFullYear();
      const orderNumber = OrderTypeormRepository.formatOrderNumber(year, newId);
      await orderRepo.update({ id: newId }, { orderNumber });

      await this.persistLines(lineRepo, order, newId);
      this.logger.debug({ orderId: newId, orderNumber }, 'Order placed');
      return newId;
    }

    const existingId = order.id;
    const rootPartial = OrderMapper.toEntity(order);
    delete rootPartial.orderNumber;
    await orderRepo.save({ ...rootPartial, id: existingId });

    await this.persistLines(lineRepo, order, existingId);
    this.logger.debug({ orderId: existingId }, 'Order updated');
    return existingId;
  }

  private async persistLines(
    lineRepo: Repository<OrderLineEntity>,
    order: Order,
    orderId: number,
  ): Promise<void> {
    const lineEntities = order.lines.map((line) => OrderLineMapper.toEntity(line, orderId));
    if (lineEntities.length > 0) {
      await lineRepo.save(lineEntities);
    }
  }

  // Resolves the order repository bound to the caller's transaction when a `scope`
  // is supplied (downcast back to the `EntityManager` the adapter brand-wraps — the
  // one place that downcast is allowed, ADR-017 §6), else the default-manager
  // repository.
  private orderRepo(scope?: ITransactionScope): Repository<OrderEntity> {
    if (!scope) {
      return this.orderRepository;
    }
    return (scope as unknown as EntityManager).getRepository(OrderEntity);
  }

  private static formatOrderNumber(year: number, id: number): string {
    return `ORD-${year}-${String(id).padStart(8, '0')}`;
  }
}
