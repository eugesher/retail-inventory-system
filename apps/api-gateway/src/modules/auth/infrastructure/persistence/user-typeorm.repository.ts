import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { User } from '../../domain/user.model';
import { IUserRepositoryPort } from '../../application/ports/user.repository.port';
import { UserEntity } from './user.entity';
import { UserMapper } from './user.mapper';

@Injectable()
export class UserTypeormRepository implements IUserRepositoryPort {
  constructor(@InjectRepository(UserEntity) private readonly repository: Repository<UserEntity>) {}

  public async findByEmail(email: string): Promise<User | null> {
    const entity = await this.repository.findOne({ where: { email: email.toLowerCase() } });
    return entity ? UserMapper.toDomain(entity) : null;
  }

  public async findById(id: string): Promise<User | null> {
    const entity = await this.repository.findOne({ where: { id } });
    return entity ? UserMapper.toDomain(entity) : null;
  }

  public async save(user: User): Promise<User> {
    const partial = UserMapper.toEntity(user);
    const saved = await this.repository.save(partial);
    return UserMapper.toDomain(saved as UserEntity);
  }

  public async softDelete(id: string): Promise<void> {
    await this.repository.softDelete(id);
  }
}
