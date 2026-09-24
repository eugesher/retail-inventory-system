import { ReturnDispositionEnum, ReturnLineConditionEnum } from '@retail-inventory-system/contracts';
import { Entity } from '@retail-inventory-system/ddd';

import { ReturnDomainException, ReturnErrorCodeEnum } from './return.exception';

export interface IReturnLineProps {
  id: number | null;
  returnRequestId: number | null;
  orderLineId: number;
  quantity: number;
  condition: ReturnLineConditionEnum | null;
  disposition: ReturnDispositionEnum | null;
  lineRefundAmountMinor: number | null;
}

export interface IInspectReturnLineInput {
  condition: ReturnLineConditionEnum;
  disposition: ReturnDispositionEnum;
  lineRefundAmountMinor: number;
}

export class ReturnLine extends Entity<number | null> {
  public readonly returnRequestId: number | null;
  public readonly orderLineId: number;
  public readonly quantity: number;
  private _condition: ReturnLineConditionEnum | null;
  private _disposition: ReturnDispositionEnum | null;
  private _lineRefundAmountMinor: number | null;

  constructor(props: IReturnLineProps) {
    if (!Number.isInteger(props.quantity) || props.quantity <= 0) {
      throw new ReturnDomainException(
        ReturnErrorCodeEnum.RETURN_LINE_QUANTITY_INVALID,
        `ReturnLine.quantity must be a positive integer, got ${props.quantity}`,
      );
    }

    super(props.id);
    this.returnRequestId = props.returnRequestId;
    this.orderLineId = props.orderLineId;
    this.quantity = props.quantity;
    this._condition = props.condition;
    this._disposition = props.disposition;
    this._lineRefundAmountMinor = props.lineRefundAmountMinor;
  }

  public get condition(): ReturnLineConditionEnum | null {
    return this._condition;
  }

  public get disposition(): ReturnDispositionEnum | null {
    return this._disposition;
  }

  public get lineRefundAmountMinor(): number | null {
    return this._lineRefundAmountMinor;
  }

  public inspect(input: IInspectReturnLineInput): void {
    if (!Object.values(ReturnLineConditionEnum).includes(input.condition)) {
      throw new ReturnDomainException(
        ReturnErrorCodeEnum.RETURN_INSPECTION_INVALID,
        `ReturnLine.inspect: unknown condition '${input.condition}'`,
      );
    }
    if (!Object.values(ReturnDispositionEnum).includes(input.disposition)) {
      throw new ReturnDomainException(
        ReturnErrorCodeEnum.RETURN_INSPECTION_INVALID,
        `ReturnLine.inspect: unknown disposition '${input.disposition}'`,
      );
    }
    if (!Number.isInteger(input.lineRefundAmountMinor) || input.lineRefundAmountMinor < 0) {
      throw new ReturnDomainException(
        ReturnErrorCodeEnum.RETURN_INSPECTION_INVALID,
        `ReturnLine.inspect: lineRefundAmountMinor must be a non-negative integer, got ${input.lineRefundAmountMinor}`,
      );
    }

    this._condition = input.condition;
    this._disposition = input.disposition;
    this._lineRefundAmountMinor = input.lineRefundAmountMinor;
  }
}
