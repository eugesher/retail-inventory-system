import { ReturnDomainException, ReturnErrorCodeEnum, ReturnRequest } from '../../domain';
import { IReturnRequestRepositoryPort } from '../ports';

// Loads a return request and asserts the caller may see it — the retail-side half of the
// bearer-plus-owner-or-staff model (ADR-028 §7 / ADR-032), shared by the return reads (and
// any owner-reachable op) so the not-found + authorization rule lives in exactly one place
// (the orders `loadAuthorizedOrder` / cart `loadOwnedCart` precedent). `staffOverride` is
// the per-operation staff grant the gateway already confirmed (`order:read` for the read
// path): a staff caller may reach any RMA, a customer only one whose order it owns. A
// permission code is a staff override layered over the owner-check, never a customer gate
// (ADR-024).
//
// A missing RMA is a 404 (`RETURN_NOT_FOUND`); a non-owner-non-staff caller is a 403
// (`RETURN_ACCESS_FORBIDDEN`) — both surface through the returns RPC exception filter. The
// owner-check compares the RMA's `customerId` (the buyer, copied from the order at Open)
// against the resolved `actorId`.
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

// Resolves a return request by id without an owner-check — for the staff-gated lifecycle
// transitions (authorize / reject / receive / close). Those routes are gated at the
// gateway with `@RequiresPermission`, so the use case trusts the gate and only needs the
// existence check (`RETURN_NOT_FOUND`, 404). Keeping it beside `loadOwnedReturn` makes the
// "owner-checked vs staff-gated" split greppable in one file.
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
