import { Module } from '@nestjs/common';

// Placeholder. Task-10 lands Prometheus-format metrics (counters, histograms)
// and registers an exporter. Empty today so app modules can already declare
// the import and pick up the wiring without churn.
@Module({})
export class MetricsModule {}
