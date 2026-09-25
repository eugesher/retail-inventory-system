export const RETURN_CUSTOMER_CONTACT_READER = Symbol('RETURN_CUSTOMER_CONTACT_READER');

export interface IReturnCustomerContact {
  email: string | null;
}

export interface IReturnCustomerContactReaderPort {
  findContactByCustomerId(customerId: string): Promise<IReturnCustomerContact | null>;
}
