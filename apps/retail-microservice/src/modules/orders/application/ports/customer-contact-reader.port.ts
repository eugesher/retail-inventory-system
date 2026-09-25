export const ORDER_CUSTOMER_CONTACT_READER = Symbol('ORDER_CUSTOMER_CONTACT_READER');

export interface IOrderCustomerContact {
  email: string | null;
}

export interface IOrderCustomerContactReaderPort {
  findContactByCustomerId(customerId: string): Promise<IOrderCustomerContact | null>;
}
