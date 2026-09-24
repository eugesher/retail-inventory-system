import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DeepPartial, LessThan, Repository } from 'typeorm';

import { BaseTypeormRepository, entityManagerOf } from '@retail-inventory-system/database';

import { Reservation, ReservationStatusEnum } from '../../domain';
import { IReservationRepositoryPort, ITransactionScope } from '../../application/ports';
import { isDuplicateEntryError } from '../../application/use-cases/mysql-error.util';
import { StockWriteConflictError } from '../../application/use-cases/stock-write-conflict.error';
import { ReservationEntity } from './reservation.entity';
import { ReservationMapper } from './reservation.mapper';

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

  public async listExpiredActive(
    now: Date,
    limit: number,
    scope?: ITransactionScope,
  ): Promise<Reservation[]> {
    const entities = await this.repo(scope).find({
      where: { status: ReservationStatusEnum.ACTIVE, expiresAt: LessThan(now) },
      order: { expiresAt: 'ASC', id: 'ASC' },
      take: limit,
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

    try {
      await repo.save(partial);
    } catch (error) {
      if (isDuplicateEntryError(error)) {
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

  private repo(scope?: ITransactionScope): Repository<ReservationEntity> {
    if (!scope) {
      return this.reservationRepository;
    }
    const manager = entityManagerOf(scope);
    return manager.getRepository(ReservationEntity);
  }

  private async reload(repo: Repository<ReservationEntity>, id: string): Promise<Reservation> {
    const reloaded = await repo.findOne({ where: { id } });
    if (!reloaded) {
      throw new Error(`ReservationTypeormRepository: reservation ${id} vanished after commit`);
    }
    return ReservationMapper.toDomain(reloaded);
  }
}
