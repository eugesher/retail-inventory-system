// Why the buyer is returning the goods — a coarse classification chosen at Open time
// and fixed for the life of the RMA. It drives downstream policy (e.g. a `defective`
// return is more likely to be scrapped than restocked) but is not itself a lifecycle
// gate. A wire contract on `ReturnRequestView` + the Open payload, mapped to the
// `return_request.reason_category` ENUM column (the `OrderStatusEnum` precedent,
// ADR-005).
export enum ReturnReasonCategoryEnum {
  DEFECTIVE = 'defective',
  NOT_AS_DESCRIBED = 'not-as-described',
  CHANGED_MIND = 'changed-mind',
  WRONG_ITEM = 'wrong-item',
}
