export interface IRefreshCommand {
  refreshToken: string;
  correlationId?: string | null;
}
