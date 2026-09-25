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

  const traceExporter = new OTLPTraceExporter();

  const sdk = new NodeSDK({
    resource,
    traceExporter,
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
