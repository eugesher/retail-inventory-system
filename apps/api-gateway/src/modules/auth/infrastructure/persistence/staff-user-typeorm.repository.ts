import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { IStaffUserRepositoryPort } from '../../application/ports';
import { StaffUser } from '../../domain';
import { StaffUserEntity } from './staff-user.entity';
import { StaffUserMapper } from './staff-user.mapper';

@Injectable()
export class StaffUserTypeormRepository implements IStaffUserRepositoryPort {
  constructor(
    @InjectRepository(StaffUserEntity)
    private readonly repository: Repository<StaffUserEntity>,
  ) {}

  public async findByEmail(email: string): Promise<StaffUser | null> {
    const entity = await this.repository.findOne({
      where: { email: email.toLowerCase() },
      relations: ['roles', 'roles.permissions'],
    });
    return entity ? StaffUserMapper.toDomain(entity) : null;
  }

  public async findById(id: string): Promise<StaffUser | null> {
    const entity = await this.repository.findOne({
      where: { id },
      relations: ['roles', 'roles.permissions'],
    });
    return entity ? StaffUserMapper.toDomain(entity) : null;
  }

  public existsActiveById(id: string): Promise<boolean> {
    // `@DeleteDateColumn` makes `existsBy` skip soft-deleted rows, so this
    // mirrors `StaffUser.isActive` (active status + not deleted) with one
    // indexed lookup and no relation joins.
    return this.repository.existsBy({ id, status: 'active' });
  }

  public async save(user: StaffUser): Promise<StaffUser> {
    const partial = StaffUserMapper.toEntity(user);
    await this.repository.save(partial);
    // Re-load so the returned aggregate reflects DB-resolved relations
    // (notably the staff_user_roles join and inflated permission sets).
    const reloaded = await this.repository.findOne({
      where: { id: user.id },
      relations: ['roles', 'roles.permissions'],
    });
    if (!reloaded) {
      throw new Error(`StaffUserTypeormRepository.save: lost row id=${user.id} after upsert`);
    }
    return StaffUserMapper.toDomain(reloaded);
  }

  public async softDelete(id: string): Promise<void> {
    await this.repository.softDelete(id);
  }
}
