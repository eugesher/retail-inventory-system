import {
  IRetailReturnAuthorizedEvent,
  IRetailReturnClosedEvent,
  IRetailReturnInspectedEvent,
  IRetailReturnReceivedEvent,
  IRetailReturnRejectedEvent,
  IRetailReturnRequestedEvent,
} from '@retail-inventory-system/contracts';

export const RETURN_EVENTS_PUBLISHER = Symbol('RETURN_EVENTS_PUBLISHER');

export interface IReturnEventsPublisherPort {
  publishReturnRequested(event: IRetailReturnRequestedEvent): Promise<void>;
  publishReturnAuthorized(event: IRetailReturnAuthorizedEvent): Promise<void>;
  publishReturnRejected(event: IRetailReturnRejectedEvent): Promise<void>;
  publishReturnReceived(event: IRetailReturnReceivedEvent): Promise<void>;
  publishReturnInspected(event: IRetailReturnInspectedEvent): Promise<void>;
  publishReturnClosed(event: IRetailReturnClosedEvent): Promise<void>;
}
