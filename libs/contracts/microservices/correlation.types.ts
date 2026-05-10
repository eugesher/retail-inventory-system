// Cross-service payload contract: every message that carries a request lives
// alongside a correlation ID for log correlation and tracing. The shape is
// defined here in `libs/contracts` because it is a wire-format concern;
// `libs/observability` re-exports it for app-side consumers.
export interface ICorrelationPayload {
  correlationId: string;
}
