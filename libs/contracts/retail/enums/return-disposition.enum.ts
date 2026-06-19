// What happens to a returned line's goods, **decided at inspection** (the warehouse
// `inventory:receive-return` step) — `null` on a `ReturnLine` until then. `RESTOCK`
// is the only disposition that triggers the cross-service restock RPC
// (`inventory.stock.restock-from-return`, which adds the quantity back to
// `quantity_on_hand` and writes a positive `return` `StockMovement`); `SCRAP` and
// `QUARANTINE` take the goods out of sellable inventory and write no stock movement.
// A wire contract on `ReturnLineView` + the Inspect payload, mapped to the nullable
// `return_line.disposition` ENUM column.
export enum ReturnDispositionEnum {
  RESTOCK = 'restock',
  SCRAP = 'scrap',
  QUARANTINE = 'quarantine',
}
