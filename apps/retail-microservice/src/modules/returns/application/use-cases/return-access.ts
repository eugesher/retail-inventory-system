import { ReturnDomainException, ReturnErrorCodeEnum, ReturnRequest } from '../../domain';
import { IReturnRequestRepositoryPort } from '../ports';

export async function loadOwnedReturn(
  repository: IReturnRequestRepositoryPort,
  rmaId: number,
  actorId: string,
  staffOverride: boolean,
): Promise<ReturnRequest> {
  const request = await repository.findById(rmaId);
  if (request === null) {
    throw new ReturnDomainException(
      ReturnErrorCodeEnum.RETURN_NOT_FOUND,
      `Return request ${rmaId} not found`,
    );
  }
  if (!staffOverride && request.customerId !== actorId) {
    throw new ReturnDomainException(
      ReturnErrorCodeEnum.RETURN_ACCESS_FORBIDDEN,
      `Return request ${rmaId} is not accessible to actor ${actorId}`,
    );
  }
  return request;
}

export async function loadReturnById(
  repository: IReturnRequestRepositoryPort,
  rmaId: number,
): Promise<ReturnRequest> {
  const request = await repository.findById(rmaId);
  if (request === null) {
    throw new ReturnDomainException(
      ReturnErrorCodeEnum.RETURN_NOT_FOUND,
      `Return request ${rmaId} not found`,
    );
  }
  return request;
}
