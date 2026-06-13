import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DeepPartial, EntityManager, Repository } from 'typeorm';

import { BaseTypeormRepository } from '@retail-inventory-system/database';

import { Reservation, ReservationStatusEnum } from '../../domain';
import { IReservationRepositoryPort, ITransactionScope } from '../../application/ports';
import { StockWriteConflictError } from '../../application/use-cases/stock-write-conflict.error';
import { ReservationEntity } from './reservation.entity';
import { ReservationMapper } from './reservation.mapper';

// MySQL's "duplicate entry for key" error number / code, duck-typed (not
// `instanceof QueryFailedError`) to match the `StockTypeormRepository` /
// auto-init-consumer checks.
const MYSQL_ER_DUP_ENTRY_ERRNO = 1062;
const MYSQL_ER_DUP_ENTRY_CODE = 'ER_DUP_ENTRY';

interface IMysqlDriverError {
  errno?: number;
  code?: string;
  driverError?: { errno?: number; code?: string };
}

// The single `@InjectRepository(ReservationEntity)` site. Extends
// `BaseTypeormRepository` for the `toDomain`/`toEntity` seam; `save` is overridden
// to be transaction-scope-aware, re-read the row, and translate a lost INSERT race
// into the shared `StockWriteConflictError`. Returns domain types only — no
// TypeORM leak past this file (ADR-017 / ADR-030).
@Injectable()
export class ReservationTypeormRepository
  extends BaseTypeormRepository<ReservationEntity, Reservation>
  implements IReservationRepositoryPort
{
  constructor(
    @InjectRepository(ReservationEntity)
    private readonly reservationRepository: Repository<ReservationEntity>,
    @InjectPinoLogger(ReservationTypeormRepository.name)
    private readonly logger: PinoLogger,
  ) {
    super(reservationRepository);
  }

  protected toDomain(entity: ReservationEntity): Reservation {
    return ReservationMapper.toDomain(entity);
  }

  protected toEntity(domain: Reservation): DeepPartial<ReservationEntity> {
    return ReservationMapper.toEntity(domain);
  }

  public async findById(id: string, scope?: ITransactionScope): Promise<Reservation | null> {
    const entity = await this.repo(scope).findOne({ where: { id } });
    return entity ? ReservationMapper.toDomain(entity) : null;
  }

  public async findByKey(
    cartId: string,
    variantId: number,
    stockLocationId: string,
    scope?: ITransactionScope,
  ): Promise<Reservation | null> {
    // The all-statuses UNIQUE triple — any one row at most, regardless of status.
    const entity = await this.repo(scope).findOne({
      where: { cartId, variantId, stockLocationId },
    });
    return entity ? ReservationMapper.toDomain(entity) : null;
  }

  public async listActiveByCart(cartId: string, scope?: ITransactionScope): Promise<Reservation[]> {
    const entities = await this.repo(scope).find({
      where: { cartId, status: ReservationStatusEnum.ACTIVE },
      order: { id: 'ASC' },
    });
    return entities.map((entity) => ReservationMapper.toDomain(entity));
  }

  public async listActiveByCartAndVariant(
    cartId: string,
    variantId: number,
    scope?: ITransactionScope,
  ): Promise<Reservation[]> {
    const entities = await this.repo(scope).find({
      where: { cartId, variantId, status: ReservationStatusEnum.ACTIVE },
      order: { id: 'ASC' },
    });
    return entities.map((entity) => ReservationMapper.toDomain(entity));
  }

  public async save(reservation: Reservation, scope?: ITransactionScope): Promise<Reservation> {
    const id = reservation.id;
    if (id === null) {
      throw new Error('ReservationTypeormRepository.save: reservation id is unexpectedly null');
    }

    const repo = this.repo(scope);
    const partial = ReservationMapper.toEntity(reservation);

    // The app-assigned UUID PK lets `save` preload by id → INSERT when absent,
    // UPDATE when present (the `Cart` idiom). A first-touch INSERT that loses the
    // `UC_RESERVATION_CART_VARIANT_LOCATION` race to a concurrent writer (who
    // created the row for the same triple under a DIFFERENT id) surfaces
    // `ER_DUP_ENTRY`. Translate it to `StockWriteConflictError` so the shared
    // bounded-retry write protocol (the Reserve / Allocate use cases, a later
    // capability) re-reads the now-present row via `findByKey` and reactivates it
    // rather than
    // duplicating — the all-statuses UNIQUE triple converges. An UPDATE never trips
    // this: a reservation never changes its triple, only its quantity / TTL /
    // status / version.
    try {
      await repo.save(partial);
    } catch (error) {
      if (ReservationTypeormRepository.isUniqueViolation(error)) {
        throw new StockWriteConflictError(reservation.variantId, reservation.stockLocationId);
      }
      throw error;
    }

    this.logger.debug(
      { reservationId: id, cartId: reservation.cartId, variantId: reservation.variantId },
      'Reservation persisted',
    );

    return this.reload(repo, id);
  }

  // Resolves the repository bound to the caller's transaction when a `scope` is
  // supplied (downcast back to the `EntityManager` the adapter brand-wraps — the
  // one place that downcast is allowed, ADR-017 §6), else the default-manager
  // repository.
  private repo(scope?: ITransactionScope): Repository<ReservationEntity> {
    if (!scope) {
      return this.reservationRepository;
    }
    const manager = scope as unknown as EntityManager;
    return manager.getRepository(ReservationEntity);
  }

  // Re-read so the returned aggregate carries the committed version + the DB
  // timestamps. The row was just written in this unit of work, so a miss here is an
  // invariant breach rather than a not-found.
  private async reload(repo: Repository<ReservationEntity>, id: string): Promise<Reservation> {
    const reloaded = await repo.findOne({ where: { id } });
    if (!reloaded) {
      throw new Error(`ReservationTypeormRepository: reservation ${id} vanished after commit`);
    }
    return ReservationMapper.toDomain(reloaded);
  }

  private static isUniqueViolation(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }
    const candidate = error as IMysqlDriverError;
    const driver = candidate.driverError ?? candidate;
    return driver.errno === MYSQL_ER_DUP_ENTRY_ERRNO || driver.code === MYSQL_ER_DUP_ENTRY_CODE;
  }
}
