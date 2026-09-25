import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectEntityManager, InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';

import { PermissionCodeEnum } from '@retail-inventory-system/contracts';

import { IRoleRepositoryPort } from '../../application/ports';
import { RoleAggregate } from '../../domain';
import { PermissionEntity } from './permission.entity';
import { RoleEntity } from './role.entity';
import { RoleMapper } from './role.mapper';

@Injectable()
export class RoleTypeormRepository implements IRoleRepositoryPort {
  constructor(
    @InjectRepository(RoleEntity) private readonly repository: Repository<RoleEntity>,
    @InjectEntityManager() private readonly entityManager: EntityManager,
  ) {}

  public async findById(id: string): Promise<RoleAggregate | null> {
    const entity = await this.repository.findOne({
      where: { id },
      relations: ['permissions'],
    });
    return entity ? RoleMapper.toDomain(entity) : null;
  }

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
    const codes = Array.from(role.permissions);
    const permissions =
      codes.length === 0
        ? []
        : await this.entityManager.getRepository(PermissionEntity).find({
            where: { code: In(codes) },
          });

    const entity = new RoleEntity();
    entity.id = role.id;
    entity.name = role.name;
    entity.description = role.description;
    entity.permissions = permissions;

    const saved = await this.repository.save(entity);
    return RoleMapper.toDomain(saved);
  }

  public async update(role: RoleAggregate, codes?: PermissionCodeEnum[]): Promise<RoleAggregate> {
    await this.entityManager.transaction(async (mgr) => {
      const roleRepo = mgr.getRepository(RoleEntity);

      const existingRole = await roleRepo.findOne({
        where: { id: role.id },
        relations: codes === undefined ? [] : ['permissions'],
      });
      if (!existingRole) {
        throw new NotFoundException(`Role ${role.id} not found`);
      }

      existingRole.description = role.description;

      if (codes !== undefined) {
        const permRepo = mgr.getRepository(PermissionEntity);
        existingRole.permissions =
          codes.length === 0 ? [] : await permRepo.find({ where: { code: In(codes) } });
      }

      await roleRepo.save(existingRole);
    });

    const reloaded = await this.findById(role.id);
    if (!reloaded) {
      throw new NotFoundException(`Role ${role.id} not found after update`);
    }
    return reloaded;
  }
}
