export interface IDomainEventProps {
  id: number | null;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  eventVersion: string;
  producer: string;
  correlationId: string | null;
  occurredAt: Date;
}

export interface ICreateDomainEventProps {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  eventVersion: string;
  producer: string;
  correlationId?: string | null;
  occurredAt: Date;
}

export class DomainEvent {
  public readonly id: number | null;
  public readonly eventType: string;
  public readonly aggregateType: string;
  public readonly aggregateId: string;
  public readonly payload: Record<string, unknown>;
  public readonly eventVersion: string;
  public readonly producer: string;
  public readonly correlationId: string | null;
  public readonly occurredAt: Date;

  private constructor(props: IDomainEventProps) {
    DomainEvent.requireNonEmpty(props.eventType, 'eventType');
    DomainEvent.requireNonEmpty(props.producer, 'producer');

    this.id = props.id;
    this.eventType = props.eventType;
    this.aggregateType = props.aggregateType;
    this.aggregateId = props.aggregateId;
    this.payload = props.payload;
    this.eventVersion = props.eventVersion;
    this.producer = props.producer;
    this.correlationId = props.correlationId;
    this.occurredAt = props.occurredAt;

    Object.freeze(this);
  }

  public static create(props: ICreateDomainEventProps): DomainEvent {
    return new DomainEvent({
      id: null,
      eventType: props.eventType,
      aggregateType: props.aggregateType,
      aggregateId: props.aggregateId,
      payload: props.payload,
      eventVersion: props.eventVersion,
      producer: props.producer,
      correlationId: props.correlationId ?? null,
      occurredAt: props.occurredAt,
    });
  }

  public static reconstitute(props: IDomainEventProps): DomainEvent {
    return new DomainEvent(props);
  }

  private static requireNonEmpty(value: string, field: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`DomainEvent: ${field} must be a non-empty string`);
    }
  }
}
