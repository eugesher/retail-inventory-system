import { EntityManager, Repository } from 'typeorm';

import { ReturnRequest } from '../../domain';
import { IReturnRequestWriteRepositoryPort } from '../../application/ports';
import { ReturnWriteConflictError } from '../../application/use-cases/return-write-conflict.error';
import { ReturnLineEntity } from './return-line.entity';
import { ReturnLineMapper } from './return-line.mapper';
import { ReturnRequestEntity } from './return-request.entity';
import { ReturnRequestMapper } from './return-request.mapper';

export class ReturnRequestWriteTypeormRepository implements IReturnRequestWriteRepositoryPort {
  constructor(
    private readonly manager: EntityManager,
    private readonly defaultManager: EntityManager,
  ) {}

  public async findById(id: number): Promise<ReturnRequest | null> {
    const entity = await this.manager.getRepository(ReturnRequestEntity).findOne({
      where: { id },
      relations: { lines: true },
      order: { lines: { id: 'ASC' } },
    });
    return entity ? ReturnRequestMapper.toDomain(entity) : null;
  }

  public async save(
    returnRequest: ReturnRequest,
    expectedVersion?: number,
  ): Promise<ReturnRequest> {
    let id: number;
    try {
      id = await this.persistGraph(returnRequest, expectedVersion);
    } catch (error) {
      if (error instanceof ReturnWriteConflictError) {
        const current = await this.defaultManager
          .getRepository(ReturnRequestEntity)
          .findOne({ where: { id: error.rmaId } });
        throw new ReturnWriteConflictError(
          error.rmaId,
          current ? Number(current.version) : expectedVersion!,
        );
      }
      throw error;
    }

    const reloaded = await this.findById(id);
    if (!reloaded) {
      throw new Error(
        `ReturnRequestWriteTypeormRepository.save: return request ${id} vanished after commit`,
      );
    }
    return reloaded;
  }

  private async persistGraph(
    returnRequest: ReturnRequest,
    expectedVersion: number | undefined,
  ): Promise<number> {
    const requestRepo = this.manager.getRepository(ReturnRequestEntity);
    const lineRepo = this.manager.getRepository(ReturnLineEntity);

    if (returnRequest.id === null) {
      const inserted = await requestRepo.save(ReturnRequestMapper.toEntity(returnRequest));
      const newId = Number(inserted.id);

      const year = returnRequest.requestedAt.getUTCFullYear();
      const rmaNumber = ReturnRequestWriteTypeormRepository.formatRmaNumber(year, newId);
      await requestRepo.update({ id: newId }, { rmaNumber });

      await this.persistLines(lineRepo, returnRequest, newId);
      return newId;
    }

    const existingId = returnRequest.id;
    await this.persistRoot(requestRepo, returnRequest, existingId, expectedVersion);

    await this.persistLines(lineRepo, returnRequest, existingId);
    return existingId;
  }

  private async persistRoot(
    requestRepo: Repository<ReturnRequestEntity>,
    returnRequest: ReturnRequest,
    existingId: number,
    expectedVersion: number | undefined,
  ): Promise<void> {
    if (expectedVersion === undefined) {
      const rootPartial = ReturnRequestMapper.toEntity(returnRequest);
      delete rootPartial.rmaNumber;
      await requestRepo.save({ ...rootPartial, id: existingId });
      return;
    }

    const result = await requestRepo.update(
      { id: existingId, version: expectedVersion },
      {
        orderId: returnRequest.orderId,
        customerId: returnRequest.customerId,
        status: returnRequest.status,
        reasonCategory: returnRequest.reasonCategory,
        notes: returnRequest.notes,
        requestedAt: returnRequest.requestedAt,
        authorizedAt: returnRequest.authorizedAt,
        closedAt: returnRequest.closedAt,
        version: (): string => 'version + 1',
      },
    );

    if (!result.affected) {
      throw new ReturnWriteConflictError(existingId, expectedVersion);
    }
  }

  private async persistLines(
    lineRepo: Repository<ReturnLineEntity>,
    returnRequest: ReturnRequest,
    returnRequestId: number,
  ): Promise<void> {
    const lineEntities = returnRequest.lines.map((line) =>
      ReturnLineMapper.toEntity(line, returnRequestId),
    );
    if (lineEntities.length > 0) {
      await lineRepo.save(lineEntities);
    }
  }

  private static formatRmaNumber(year: number, id: number): string {
    return `RMA-${year}-${String(id).padStart(8, '0')}`;
  }
}
