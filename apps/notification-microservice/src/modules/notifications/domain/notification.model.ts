import { NotificationChannelEnum } from '@retail-inventory-system/contracts';
import { ValueObject } from '@retail-inventory-system/ddd';

export interface INotificationProps extends Record<string, unknown> {
  recipient: string;
  channel: NotificationChannelEnum;
  subject: string;
  body: string;
  metadata: Record<string, unknown>;
}

export class Notification extends ValueObject<INotificationProps> {
  constructor(props: INotificationProps) {
    if (!props.recipient || props.recipient.trim().length === 0) {
      throw new Error('Notification: recipient must be non-empty');
    }
    if (!props.subject || props.subject.trim().length === 0) {
      throw new Error('Notification: subject must be non-empty');
    }
    if (!props.body || props.body.trim().length === 0) {
      throw new Error('Notification: body must be non-empty');
    }
    if (!Object.values(NotificationChannelEnum).includes(props.channel)) {
      throw new Error(`Notification: unknown channel '${String(props.channel)}'`);
    }

    super({ ...props, metadata: { ...props.metadata } });
  }

  public get recipient(): string {
    return this.props.recipient;
  }

  public get channel(): NotificationChannelEnum {
    return this.props.channel;
  }

  public get subject(): string {
    return this.props.subject;
  }

  public get body(): string {
    return this.props.body;
  }

  public get metadata(): Readonly<Record<string, unknown>> {
    return this.props.metadata;
  }
}
