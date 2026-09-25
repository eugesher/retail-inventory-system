import { DomainException } from '@retail-inventory-system/common';

import { NotificationErrorCodeEnum } from './notification-error-code.enum';

export class NotificationDomainException extends DomainException {
  public readonly code: NotificationErrorCodeEnum;

  constructor(code: NotificationErrorCodeEnum, message: string) {
    super(message);
    this.code = code;
  }
}
