import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { RESERVATION_SWEEP_INTERVAL_SECONDS } from '../../application/ports';
import { SweepExpiredReservationsUseCase } from '../../application/use-cases';

export const RESERVATION_SWEEP_INTERVAL_NAME = 'reservation-ttl-sweep';

@Injectable()
export class ReservationSweepScheduler implements OnModuleInit, OnModuleDestroy {
  private sweeping = false;

  constructor(
    private readonly sweeper: SweepExpiredReservationsUseCase,
    private readonly schedulerRegistry: SchedulerRegistry,
    @Inject(RESERVATION_SWEEP_INTERVAL_SECONDS)
    private readonly intervalSeconds: number,
    @InjectPinoLogger(ReservationSweepScheduler.name)
    private readonly logger: PinoLogger,
  ) {}

  public onModuleInit(): void {
    const intervalMs = this.intervalSeconds * 1000;
    const handle = setInterval(() => void this.sweep(), intervalMs);
    this.schedulerRegistry.addInterval(RESERVATION_SWEEP_INTERVAL_NAME, handle);
    this.logger.info({ intervalSeconds: this.intervalSeconds }, 'Reservation sweep scheduled');
  }

  public onModuleDestroy(): void {
    if (this.schedulerRegistry.doesExist('interval', RESERVATION_SWEEP_INTERVAL_NAME)) {
      this.schedulerRegistry.deleteInterval(RESERVATION_SWEEP_INTERVAL_NAME);
    }
  }

  private async sweep(): Promise<void> {
    if (this.sweeping) {
      this.logger.debug({}, 'Reservation sweep still running — skipping this tick');
      return;
    }

    this.sweeping = true;
    try {
      await this.sweeper.execute();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn({ reason }, 'Reservation sweep failed');
    } finally {
      this.sweeping = false;
    }
  }
}
