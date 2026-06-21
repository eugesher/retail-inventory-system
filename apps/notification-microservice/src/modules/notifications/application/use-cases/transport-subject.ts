// The `Notification` value object requires a NON-empty subject (it rejects an empty one),
// but a null-subject channel (sms/push) renders none — so the transport falls back to a
// meaningful line. Shared by the first-dispatch pipeline (`RenderAndDispatchUseCase`,
// fallback = the event type) and the retry path (`RetryDeliveryUseCase`, fallback = the
// persisted event reference type) so the empty-subject transport rule lives in exactly
// one place rather than being re-derived per caller. The fallback is a transport detail —
// the persisted `renderedSubject` stays null (the channel really has no subject).
export const resolveTransportSubject = (
  renderedSubject: string | null,
  fallback: string,
): string =>
  renderedSubject !== null && renderedSubject.trim().length > 0 ? renderedSubject : fallback;
