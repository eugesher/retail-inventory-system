// OpenTelemetry bootstrap. **Side-effect import only** — must run before
// `NestFactory.create*()` so auto-instrumentation can patch HTTP, MySQL
// (TypeORM), Redis, and AMQP modules in time. Importing this file from a
// service `main.ts` is the contract; do not invoke any function from here.
//
// Concrete `NodeSDK` config (exporter, propagator, resource attributes) is
// finished in task-10. This file ships the shell so app `main.ts` files can
// already wire `import '@retail-inventory-system/observability/tracer';`
// without breaking when task-10 lands the body.

// Intentionally empty body. When task-10 fills it in, the imports will
// resolve `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`,
// the OTLP exporter, and W3C trace-context propagator, then call
// `sdk.start()`. Node SDK lifecycle (shutdown on SIGTERM) is also wired
// there.
export {};
