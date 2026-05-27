import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { IRoleRepositoryPort } from '../../application/ports/role.repository.port';
import { RoleAggregate } from '../../domain/role.aggregate';
import { RoleEntity } from './role.entity';
import { RoleMapper } from './role.mapper';

@Injectable()
export class RoleTypeormRepository implements IRoleRepositoryPort {
  constructor(@InjectRepository(RoleEntity) private readonly repository: Repository<RoleEntity>) {}

  public async findByName(name: string): Promise<RoleAggregate | null> {
    const entity = await this.repository.findOne({
      where: { name },
      relations: ['permissions'],
    });
    return entity ? RoleMapper.toDomain(entity) : null;
  }

  public async findAllByNames(names: string[]): Promise<RoleAggregate[]> {
    if (names.length === 0) return [];
    const entities = await this.repository.find({
      where: { name: In(names) },
      relations: ['permissions'],
    });
    return entities.map((e) => RoleMapper.toDomain(e));
  }

  public async findAll(): Promise<RoleAggregate[]> {
    const entities = await this.repository.find({ relations: ['permissions'] });
    return entities.map((e) => RoleMapper.toDomain(e));
  }

  public async save(role: RoleAggregate): Promise<RoleAggregate> {
    const partial = RoleMapper.toEntity(role);
    const saved = await this.repository.save(partial);
    return RoleMapper.toDomain(saved as RoleEntity);
  }
}
