import { ApiResponseProperty } from '@nestjs/swagger';

export interface IHealthPingResult {
  status: 'ok';
  service: string;
}

export type ServiceHealthStatus = 'ok' | 'timeout' | 'error';

export class ServiceHealthView {
  @ApiResponseProperty({ example: 'ok' })
  public status!: ServiceHealthStatus;

  @ApiResponseProperty({ example: 4 })
  public latencyMs?: number;
}

export class SystemHealthView {
  @ApiResponseProperty({ example: 'degraded' })
  public status!: 'ok' | 'degraded';

  @ApiResponseProperty()
  public services!: Record<string, ServiceHealthView>;
}
