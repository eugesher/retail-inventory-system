import { ReturnReasonCategoryEnum, ReturnStatusEnum } from '@retail-inventory-system/contracts';
import { AggregateRoot } from '@retail-inventory-system/ddd';

import { ReturnLine } from './return-line.model';
import { ReturnDomainException, ReturnErrorCodeEnum } from './return.exception';

export interface IReturnRequestProps {
  id: number | null;
  rmaNumber: string | null;
  orderId: number;
  customerId: string;
  status?: ReturnStatusEnum;
  reasonCategory: ReturnReasonCategoryEnum;
  notes: string | null;
  requestedAt: Date;
  authorizedAt: Date | null;
  closedAt: Date | null;
  lines: ReturnLine[];
  version?: number;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

export interface IOpenReturnRequestInput {
  orderId: number;
  customerId: string;
  reasonCategory: ReturnReasonCategoryEnum;
  notes: string | null;
  lines: { orderLineId: number; quantity: number }[];
}

export class ReturnRequest extends AggregateRoot<number | null> {
  private readonly _rmaNumber: string | null;
  private readonly _orderId: number;
  private readonly _customerId: string;
  private _status: ReturnStatusEnum;
  private readonly _reasonCategory: ReturnReasonCategoryEnum;
  private _notes: string | null;
  private readonly _requestedAt: Date;
  private _authorizedAt: Date | null;
  private _closedAt: Date | null;
  private readonly _lines: ReturnLine[];
  private _version: number;
  public readonly createdAt: Date | null;
  public readonly updatedAt: Date | null;

  private constructor(props: IReturnRequestProps) {
    if (props.lines.length === 0) {
      throw new ReturnDomainException(
        ReturnErrorCodeEnum.RETURN_NO_LINES,
        'ReturnRequest must carry at least one line',
      );
    }

    super(props.id);
    this._rmaNumber = props.rmaNumber;
    this._orderId = props.orderId;
    this._customerId = props.customerId;
    this._status = props.status ?? ReturnStatusEnum.REQUESTED;
    this._reasonCategory = props.reasonCategory;
    this._notes = props.notes;
    this._requestedAt = props.requestedAt;
    this._authorizedAt = props.authorizedAt;
    this._closedAt = props.closedAt;
    this._lines = props.lines;
    this._version = props.version ?? 0;
    this.createdAt = props.createdAt ?? null;
    this.updatedAt = props.updatedAt ?? null;
  }

  public static open(input: IOpenReturnRequestInput, now: Date = new Date()): ReturnRequest {
    const lines = input.lines.map(
      (line) =>
        new ReturnLine({
          id: null,
          returnRequestId: null,
          orderLineId: line.orderLineId,
          quantity: line.quantity,
          condition: null,
          disposition: null,
          lineRefundAmountMinor: null,
        }),
    );
    return new ReturnRequest({
      id: null,
      rmaNumber: null,
      orderId: input.orderId,
      customerId: input.customerId,
      status: ReturnStatusEnum.REQUESTED,
      reasonCategory: input.reasonCategory,
      notes: input.notes,
      requestedAt: now,
      authorizedAt: null,
      closedAt: null,
      lines,
      version: 0,
    });
  }

  public static reconstitute(props: IReturnRequestProps): ReturnRequest {
    return new ReturnRequest(props);
  }

  public get rmaNumber(): string | null {
    return this._rmaNumber;
  }

  public get orderId(): number {
    return this._orderId;
  }

  public get customerId(): string {
    return this._customerId;
  }

  public get status(): ReturnStatusEnum {
    return this._status;
  }

  public get reasonCategory(): ReturnReasonCategoryEnum {
    return this._reasonCategory;
  }

  public get notes(): string | null {
    return this._notes;
  }

  public get requestedAt(): Date {
    return this._requestedAt;
  }

  public get authorizedAt(): Date | null {
    return this._authorizedAt;
  }

  public get closedAt(): Date | null {
    return this._closedAt;
  }

  public get lines(): readonly ReturnLine[] {
    return this._lines;
  }

  public get version(): number {
    return this._version;
  }

  public authorize(at: Date): void {
    this.assertStatus(ReturnStatusEnum.REQUESTED, 'authorize', `current: ${this._status}`);
    this._status = ReturnStatusEnum.AUTHORIZED;
    this._authorizedAt = at;
    this.bumpVersion();
  }

  public reject(at: Date, reason?: string | null): void {
    this.assertStatus(ReturnStatusEnum.REQUESTED, 'reject', `current: ${this._status}`);
    this._status = ReturnStatusEnum.REJECTED;
    this._closedAt = at;
    if (reason && reason.trim().length > 0) {
      const trimmed = reason.trim();
      this._notes = this._notes ? `${this._notes}\nRejected: ${trimmed}` : `Rejected: ${trimmed}`;
    }
    this.bumpVersion();
  }

  public receive(): void {
    this.assertStatus(ReturnStatusEnum.AUTHORIZED, 'receive', `current: ${this._status}`);
    this._status = ReturnStatusEnum.RECEIVED;
    this.bumpVersion();
  }

  public markInspected(): void {
    this.assertStatus(ReturnStatusEnum.RECEIVED, 'markInspected', `current: ${this._status}`);
    this._status = ReturnStatusEnum.INSPECTED;
    this.bumpVersion();
  }

  public close(at: Date): void {
    this.assertStatus(ReturnStatusEnum.INSPECTED, 'close', `current: ${this._status}`);
    this._status = ReturnStatusEnum.CLOSED;
    this._closedAt = at;
    this.bumpVersion();
  }

  private assertStatus(expected: ReturnStatusEnum, op: string, detail: string): void {
    if (this._status !== expected) {
      throw new ReturnDomainException(
        ReturnErrorCodeEnum.RETURN_INVALID_STATUS_TRANSITION,
        `ReturnRequest.${op}: can only ${op} a ${expected} return request (${detail})`,
      );
    }
  }

  private bumpVersion(): void {
    this._version += 1;
  }
}
