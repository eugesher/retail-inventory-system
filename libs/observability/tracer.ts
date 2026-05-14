// OpenTelemetry bootstrap. **Side-effect import only** — must run before
// `NestFactory.create*()` so auto-instrumentation can patch HTTP, MySQL
// (TypeORM), Redis, and AMQP modules in time. Importing this file from a
// service `main.ts` is the contract; do not invoke any function from here.
//
// Configuration is read from environment variables; see `.env.example`:
//   OTEL_SERVICE_NAME            — per-service name (e.g. api-gateway)
//   OTEL_EXPORTER_OTLP_ENDPOINT  — OTLP/HTTP collector URL (must end with /v1/traces)
//   OTEL_RESOURCE_ATTRIBUTES     — optional comma-separated k=v list merged into resource
//   OTEL_SDK_DISABLED            — set to 'true' to skip bootstrap entirely
//
// ADR-014 records why we ship traces via OTLP/HTTP to an OTel collector and
// then on to Jaeger. ADR-015 covers the Pino trace-correlation hook that
// reads the active span from this SDK at log time.

import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  ATTR_SERVICE_NAME,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from '@opentelemetry/semantic-conventions';

const SDK_DISABLED = process.env.OTEL_SDK_DISABLED === 'true';

if (!SDK_DISABLED) {
  if (process.env.OTEL_DIAG_LOG_LEVEL === 'debug') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  const serviceName = process.env.OTEL_SERVICE_NAME ?? 'unknown-service';
  const environment = process.env.NODE_ENV ?? 'development';

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: environment,
  });

  // OTLPTraceExporter respects OTEL_EXPORTER_OTLP_ENDPOINT and
  // OTEL_EXPORTER_OTLP_TRACES_ENDPOINT; passing an explicit url is optional.
  const traceExporter = new OTLPTraceExporter();

  const sdk = new NodeSDK({
    resource,
    traceExporter,
    // amqplib auto-instrumentation injects `traceparent` into AMQP message
    // headers on publish and extracts it on consume — which is how the
    // gateway → retail → inventory → notification trace stays a single
    // trace across RabbitMQ hops.
    instrumentations: [getNodeAutoInstrumentations()],
  });

  sdk.start();

  const shutdown = (): void => {
    sdk
      .shutdown()
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('OpenTelemetry shutdown error', err);
      })
      .finally(() => process.exit(0));
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

export {};
