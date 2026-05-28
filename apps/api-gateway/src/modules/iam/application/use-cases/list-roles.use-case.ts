import { Inject, Injectable } from '@nestjs/common';

import { IRoleRepositoryPort, ROLE_REPOSITORY, RoleAggregate } from '../../../auth';

@Injectable()
export class ListRolesUseCase {
  constructor(@Inject(ROLE_REPOSITORY) private readonly roles: IRoleRepositoryPort) {}

  public async execute(): Promise<RoleAggregate[]> {
    const roles = await this.roles.findAll();
    return roles.sort((a, b) => a.name.localeCompare(b.name));
  }
}
