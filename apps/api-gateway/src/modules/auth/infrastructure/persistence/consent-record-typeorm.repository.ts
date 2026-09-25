import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { IConsentRecordRepositoryPort } from '../../application/ports';
import { ConsentRecord } from '../../domain';
import { ConsentRecordEntity } from './consent-record.entity';
import { ConsentRecordMapper } from './consent-record.mapper';

@Injectable()
export class ConsentRecordTypeormRepository implements IConsentRecordRepositoryPort {
  constructor(
    @InjectRepository(ConsentRecordEntity)
    private readonly repository: Repository<ConsentRecordEntity>,
  ) {}

  public async findByCustomerId(customerId: string): Promise<ConsentRecord | null> {
    const entity = await this.repository.findOne({ where: { customerId } });
    return entity ? ConsentRecordMapper.toDomain(entity) : null;
  }

  public async save(record: ConsentRecord): Promise<ConsentRecord> {
    const partial = ConsentRecordMapper.toEntity(record);
    await this.repository.save(partial);
    const reloaded = await this.repository.findOne({ where: { customerId: record.customerId } });
    if (!reloaded) {
      throw new Error(
        `ConsentRecordTypeormRepository.save: lost row customerId=${record.customerId} after upsert`,
      );
    }
    return ConsentRecordMapper.toDomain(reloaded);
  }
}
