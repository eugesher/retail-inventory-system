// The physical condition a returned line's goods are in, **recorded at inspection**
// (the warehouse `inventory:receive-return` step) — `null` on a `ReturnLine` until
// then. It informs the disposition decision: a `NEW` item is the obvious restock
// candidate, a `DAMAGED` one the obvious scrap. A wire contract on `ReturnLineView` +
// the Inspect payload, mapped to the nullable `return_line.condition` ENUM column.
export enum ReturnLineConditionEnum {
  NEW = 'new',
  DAMAGED = 'damaged',
  USED = 'used',
}
