import { ICorrelationPayload } from '../../microservices';
import { ReturnDispositionEnum, ReturnLineConditionEnum, ReturnReasonCategoryEnum } from '../enums';

// Wire-format command payloads for the return (RMA) RPCs (ADR-032). One type, both ends: the
// gateway adapter sends it and the retail use case consumes it as its `execute(payload)` input,
// so a drift fails TypeScript on **both** sides. That is the contract test.
//
// **Authorization is split across the boundary (ADR-024 / ADR-028 §7), and that is why these
// payloads look the way they do.** The gateway resolves the permission and folds the *result*
// into the payload — never the permissions themselves:
//
//   * `isStaff: boolean` — an owner-or-staff command. The gateway has already checked the
//     override (`order:return-authorize` on Open, `order:read` on the reads); the retail use
//     case owner-checks `order.customerId === customerId` unless the flag is set, and **never
//     re-reads the permission registry**.
//   * no `isStaff` — a staff-only command, gated at the gateway with `@RequiresPermission`.
//     There is nothing left for retail to decide, so the payload carries only `actorId`, for
//     the audit row.
//
// A payload that grew a permission list instead of a boolean would move the authorization
// decision across the wire, which is the thing this shape exists to prevent.

export interface IRetailReturnOpenPayload extends ICorrelationPayload {
  orderId: number;
  customerId: string;
  isStaff: boolean;
  reasonCategory: ReturnReasonCategoryEnum;
  notes?: string;
  lines: { orderLineId: number; quantity: number }[];
}

export interface IRetailReturnAuthorizePayload extends ICorrelationPayload {
  rmaId: number;
  actorId: string;
}

export interface IRetailReturnRejectPayload extends ICorrelationPayload {
  rmaId: number;
  reason?: string;
  actorId: string;
}

export interface IRetailReturnReceivePayload extends ICorrelationPayload {
  rmaId: number;
  actorId: string;
}

// `lines` must carry **every** line of the RMA, not just the ones being restocked: the use case
// requires a complete inspection, so an `inspected` RMA can never hold a half-inspected line. A
// caller that omits one is rejected. `lineRefundAmountMinor` is non-negative minor units.
export interface IRetailReturnInspectPayload extends ICorrelationPayload {
  rmaId: number;
  actorId: string;
  lines: {
    returnLineId: number;
    condition: ReturnLineConditionEnum;
    disposition: ReturnDispositionEnum;
    lineRefundAmountMinor: number;
  }[];
}

export interface IRetailReturnClosePayload extends ICorrelationPayload {
  rmaId: number;
  actorId: string;
}

export interface IRetailReturnGetPayload extends ICorrelationPayload {
  rmaId: number;
  actorId: string;
  isStaff: boolean;
}

// The owner-check resolves the buyer from the **ORDER**, not from the RMA rows — a caller who does
// not own the order is refused with `RETURN_ACCESS_FORBIDDEN` (403), never handed an empty list
// (ADR-051). Checking the rows instead was the old shape and it leaked anyway: it answered *"does
// this order have returns?"* to a caller who may not know the order exists.
export interface IRetailReturnListPayload extends ICorrelationPayload {
  orderId: number;
  actorId: string;
  isStaff: boolean;
}
