import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { ICurrentUser } from '@retail-inventory-system/contracts';

interface IRequestWithUser {
  user?: ICurrentUser;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ICurrentUser | undefined => {
    const request: IRequestWithUser = ctx.switchToHttp().getRequest<IRequestWithUser>();
    return request.user;
  },
);
