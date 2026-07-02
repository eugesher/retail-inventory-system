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
import { OrderWriteConflictError } from '../../application/use-cases/order-write-conflict.error';
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

  public async save(
    order: Order,
    scope?: ITransactionScope,
    expectedVersion?: number,
  ): Promise<Order> {
    // One transaction for the root + its lines: a half-written graph (the header
    // committed but a line missing) would corrupt the totals the order view reports.
    // When the caller already owns a transaction (`scope`), join it — the place flow
    // commits the order, addresses, and cart conversion atomically — else open one.
    // When `expectedVersion` is supplied (a status transition on an existing order) the
    // root write is an optimistic compare-and-swap (ADR-036); otherwise it is a plain
    // insert (place) or a managed save (the inline authorize-on-place write).
    let orderId: number;
    try {
      if (scope) {
        orderId = await this.persistGraph(
          scope as unknown as EntityManager,
          order,
          expectedVersion,
        );
      } else {
        orderId = await this.orderRepository.manager.transaction((manager) =>
          this.persistGraph(manager, order, expectedVersion),
        );
      }
    } catch (error) {
      if (error instanceof OrderWriteConflictError) {
        // The transaction rolled back on the lost CAS. Read the row's now-current
        // version on a fresh query (the default manager, NOT the rolled-back scope's
        // snapshot — a plain SELECT never blocks on the zero-row UPDATE's row lock) so
        // the conflict signal carries the accurate committed version the caller should
        // refetch. A vanished row (never in practice — an order is not deleted) falls
        // back to the version we targeted.
        const current = await this.orderRepository.findOne({ where: { id: error.orderId } });
        throw new OrderWriteConflictError(
          error.orderId,
          current ? Number(current.version) : expectedVersion!,
        );
      }
      throw error;
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
  // fulfillment-status / version bump) `order_number` is immutable, so update the root
  // without touching `order_number`; the lines are re-persisted too because a line's
  // `status` advances as shipments go out (the Ship operation, ADR-031), so a re-save
  // is no longer guaranteed to leave the lines untouched.
  private async persistGraph(
    manager: EntityManager,
    order: Order,
    expectedVersion: number | undefined,
  ): Promise<number> {
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
    await this.persistRoot(orderRepo, order, existingId, expectedVersion);

    // The line money/identity columns are immutable place-time snapshots, but a
    // line's `status` advances as the order ships (`OrderLine.markFulfillment`, the
    // Ship operation — ADR-031). Each line already carries its concrete id, so
    // re-persisting upserts in place (a status-column UPDATE) without inserting
    // duplicates — the price snapshot is re-written with identical values. This runs
    // only after the root CAS succeeded, so a losing attempt writes no lines.
    await this.persistLines(lineRepo, order, existingId);
    this.logger.debug({ orderId: existingId }, 'Order updated');
    return existingId;
  }

  // Persists the order root on a re-save. When `expectedVersion` is supplied it is an
  // optimistic compare-and-swap on the root `version` (ADR-036): the root version is
  // the aggregate's OCC anchor, so every status transition bumps it via
  // `version = version + 1`, and the `WHERE id = ? AND version = expectedVersion`
  // predicate makes a concurrent writer (who already bumped it) match zero rows — a
  // retryable `OrderWriteConflictError` rather than a silent lost update. Two
  // concurrent order writes therefore serialize through this single UPDATE. When
  // `expectedVersion` is absent the write is the plain managed save (the inline
  // authorize-on-place path, running on a brand-new order with no concurrent writer)
  // — TypeORM still advances `@VersionColumn`. `order_number` is immutable, so it is
  // never written on a re-save.
  private async persistRoot(
    orderRepo: Repository<OrderEntity>,
    order: Order,
    existingId: number,
    expectedVersion: number | undefined,
  ): Promise<void> {
    if (expectedVersion === undefined) {
      const rootPartial = OrderMapper.toEntity(order);
      delete rootPartial.orderNumber;
      await orderRepo.save({ ...rootPartial, id: existingId });
      return;
    }

    const result = await orderRepo.update(
      { id: existingId, version: expectedVersion },
      {
        customerId: order.customerId,
        currency: order.currency,
        status: order.status,
        paymentStatus: order.paymentStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        subtotalMinor: order.subtotalMinor,
        taxTotalMinor: order.taxTotalMinor,
        discountTotalMinor: order.discountTotalMinor,
        shippingTotalMinor: order.shippingTotalMinor,
        grandTotalMinor: order.grandTotalMinor,
        billingAddressId: order.billingAddressId,
        shippingAddressId: order.shippingAddressId,
        sourceCartId: order.sourceCartId,
        placedAt: order.placedAt,
        version: (): string => 'version + 1',
      },
    );

    if (!result.affected) {
      // Signal a lost race; the outer `save` re-reads the committed version and
      // rethrows a conflict carrying it (kept out of this snapshot-bound tx).
      throw new OrderWriteConflictError(existingId, expectedVersion);
    }
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
