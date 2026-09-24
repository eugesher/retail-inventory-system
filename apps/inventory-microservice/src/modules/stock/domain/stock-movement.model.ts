import { StockMovementTypeEnum } from '@retail-inventory-system/contracts';

export interface IStockMovementProps {
  id: number | null;
  variantId: number;
  stockLocationId: string;
  type: StockMovementTypeEnum;
  quantity: number;
  reasonCode: string | null;
  referenceType: string | null;
  referenceId: string | null;
  actorId: string | null;
  operationKey: string | null;
  occurredAt: Date;
}

export interface IRecordStockMovementProps {
  variantId: number;
  stockLocationId: string;
  type: StockMovementTypeEnum;
  quantity: number;
  reasonCode?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  actorId?: string | null;
  operationKey?: string | null;
  occurredAt?: Date;
}

const POSITIVE_TYPES: ReadonlySet<StockMovementTypeEnum> = new Set([
  StockMovementTypeEnum.RECEIPT,
  StockMovementTypeEnum.RETURN,
]);
const NEGATIVE_TYPES: ReadonlySet<StockMovementTypeEnum> = new Set([
  StockMovementTypeEnum.SALE,
  StockMovementTypeEnum.ALLOCATION,
  StockMovementTypeEnum.RELEASE,
]);

export class StockMovement {
  public readonly id: number | null;
  public readonly variantId: number;
  public readonly stockLocationId: string;
  public readonly type: StockMovementTypeEnum;
  public readonly quantity: number;
  public readonly reasonCode: string | null;
  public readonly referenceType: string | null;
  public readonly referenceId: string | null;
  public readonly actorId: string | null;
  public readonly operationKey: string | null;
  public readonly occurredAt: Date;

  private constructor(props: IStockMovementProps) {
    StockMovement.requireSignForType(props.type, props.quantity);

    this.id = props.id;
    this.variantId = props.variantId;
    this.stockLocationId = props.stockLocationId;
    this.type = props.type;
    this.quantity = props.quantity;
    this.reasonCode = props.reasonCode;
    this.referenceType = props.referenceType;
    this.referenceId = props.referenceId;
    this.actorId = props.actorId;
    this.operationKey = props.operationKey;
    this.occurredAt = props.occurredAt;

    Object.freeze(this);
  }

  public static record(props: IRecordStockMovementProps): StockMovement {
    return new StockMovement({
      id: null,
      variantId: props.variantId,
      stockLocationId: props.stockLocationId,
      type: props.type,
      quantity: props.quantity,
      reasonCode: props.reasonCode ?? null,
      referenceType: props.referenceType ?? null,
      referenceId: props.referenceId ?? null,
      actorId: props.actorId ?? null,
      operationKey: props.operationKey ?? null,
      occurredAt: props.occurredAt ?? new Date(),
    });
  }

  public static reconstitute(props: IStockMovementProps): StockMovement {
    return new StockMovement(props);
  }

  private static requireSignForType(type: StockMovementTypeEnum, quantity: number): void {
    if (!Number.isInteger(quantity) || quantity === 0) {
      throw new Error(`StockMovement: quantity must be a non-zero integer, got ${quantity}`);
    }
    if (POSITIVE_TYPES.has(type) && quantity < 0) {
      throw new Error(
        `StockMovement: a '${type}' movement must have a strictly positive quantity, got ${quantity}`,
      );
    }
    if (NEGATIVE_TYPES.has(type) && quantity > 0) {
      throw new Error(
        `StockMovement: a '${type}' movement must have a strictly negative quantity, got ${quantity}`,
      );
    }
  }
}
