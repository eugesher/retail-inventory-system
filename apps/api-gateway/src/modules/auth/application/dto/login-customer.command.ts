export interface ILoginCustomerCommand {
  email: string;
  password: string;
  correlationId?: string | null;
}
