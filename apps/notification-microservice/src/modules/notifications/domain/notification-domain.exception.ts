import { DomainException } from '@retail-inventory-system/common';

import { NotificationErrorCodeEnum } from './notification-error-code.enum';

// One concrete throwable for the notification bounded context, carrying a typed `code`
// from `NotificationErrorCodeEnum`. The notification microservice gains its first
// concrete `DomainException` here (the earlier `Notification` value object threw plain
// `Error`); it satisfies the framework-free base's abstract `code` contract (the
// ADR-025 pattern, mirroring `OrderDomainException` / `InventoryDomainException` /
// `ReturnDomainException`). Assert `err.code`, never string-match the message — the
// presentation filter maps the code → HTTP status, the domain stays transport-free.
export class NotificationDomainException extends DomainException {
  public readonly code: NotificationErrorCodeEnum;

  constructor(code: NotificationErrorCodeEnum, message: string) {
    super(message);
    this.code = code;
  }
}
