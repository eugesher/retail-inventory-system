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
    // Resolve permission ids by code — RoleAggregate stores codes (the
    // domain key), TypeORM's join table needs the id (the surrogate key).
    // Skipping this lookup leaves `role_permissions` rows uninserted on a
    // `repository.save(partial)` call with code-only DeepPartials.
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

  // Hand-rolled DELETE + INSERT inside a single tx — `repository.save` with
  // a `permissions: []` relation does not reliably clear the join rows in
  // every TypeORM version, and we want observers reading `role_permissions`
  // to never see a transient empty set.
  public async replacePermissions(
    role: RoleAggregate,
    codes: PermissionCodeEnum[],
  ): Promise<RoleAggregate> {
    await this.entityManager.transaction(async (mgr) => {
      const roleRepo = mgr.getRepository(RoleEntity);
      const permRepo = mgr.getRepository(PermissionEntity);

      const existingRole = await roleRepo.findOne({ where: { id: role.id } });
      if (!existingRole) {
        throw new NotFoundException(`Role ${role.id} not found`);
      }

      // Setting the inverse side + saving via the parent does the
      // delete-old + insert-new on the join table in one logical step.
      existingRole.permissions =
        codes.length === 0 ? [] : await permRepo.find({ where: { code: In(codes) } });
      await roleRepo.save(existingRole);
    });

    const reloaded = await this.findById(role.id);
    if (!reloaded) {
      throw new NotFoundException(`Role ${role.id} not found after replacePermissions`);
    }
    return reloaded;
  }
}
