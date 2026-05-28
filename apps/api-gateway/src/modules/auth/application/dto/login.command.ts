export interface ILoginCommand {
  email: string;
  password: string;
  correlationId?: string | null;
}
