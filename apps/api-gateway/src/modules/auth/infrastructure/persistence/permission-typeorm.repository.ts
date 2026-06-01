import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { IPermissionRepositoryPort } from '../../application/ports/permission.repository.port';
import { PermissionAggregate } from '../../domain/permission.aggregate';
import { PermissionEntity } from './permission.entity';
import { PermissionMapper } from './permission.mapper';

@Injectable()
export class PermissionTypeormRepository implements IPermissionRepositoryPort {
  constructor(
    @InjectRepository(PermissionEntity)
    private readonly repository: Repository<PermissionEntity>,
  ) {}

  public async findAll(): Promise<PermissionAggregate[]> {
    const entities = await this.repository.find();
    return entities.map((e) => PermissionMapper.toDomain(e));
  }

  public async findByCodes(codes: string[]): Promise<PermissionAggregate[]> {
    if (codes.length === 0) return [];
    const entities = await this.repository.find({ where: { code: In(codes) } });
    return entities.map((e) => PermissionMapper.toDomain(e));
  }
}
