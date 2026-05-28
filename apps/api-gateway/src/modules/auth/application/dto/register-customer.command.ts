export interface IRegisterCustomerCommand {
  email: string;
  password: string;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  correlationId?: string | null;
}
