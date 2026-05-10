import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { RoleEnum } from '@retail-inventory-system/contracts';

import { RoleVO } from '../../domain/role.model';
import { User } from '../../domain/user.model';
import { PASSWORD_HASHER, IPasswordPort } from '../ports/password.port';
import { IUserRepositoryPort, USER_REPOSITORY } from '../ports/user.repository.port';

export interface IRegisterUserCommand {
  email: string;
  password: string;
  roles?: RoleEnum[];
}

@Injectable()
export class RegisterUserUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: IUserRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: IPasswordPort,
  ) {}

  public async execute(command: IRegisterUserCommand): Promise<User> {
    const normalizedEmail = command.email.trim().toLowerCase();

    const existing = await this.users.findByEmail(normalizedEmail);
    if (existing) {
      throw new ConflictException('A user with that email already exists');
    }

    const passwordHash = await this.hasher.hash(command.password);
    const roles = (command.roles ?? [RoleEnum.CUSTOMER]).map((role) => new RoleVO(role));
    const user = User.register(randomUUID(), {
      email: normalizedEmail,
      passwordHash,
      roles,
    });

    return this.users.save(user);
  }
}
