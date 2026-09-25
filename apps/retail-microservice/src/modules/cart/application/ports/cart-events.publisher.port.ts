import {
  IRetailCartCreatedEvent,
  IRetailCartLineAddedEvent,
  IRetailCartLineQuantityChangedEvent,
  IRetailCartLineRemovedEvent,
} from '@retail-inventory-system/contracts';

export const CART_EVENTS_PUBLISHER = Symbol('CART_EVENTS_PUBLISHER');

export interface ICartEventsPublisherPort {
  publishCartCreated(event: IRetailCartCreatedEvent): Promise<void>;
  publishCartLineAdded(event: IRetailCartLineAddedEvent): Promise<void>;
  publishCartLineRemoved(event: IRetailCartLineRemovedEvent): Promise<void>;
  publishCartLineQuantityChanged(event: IRetailCartLineQuantityChangedEvent): Promise<void>;
}
