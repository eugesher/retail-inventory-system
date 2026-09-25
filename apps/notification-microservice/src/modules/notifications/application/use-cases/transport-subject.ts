export const resolveTransportSubject = (
  renderedSubject: string | null,
  fallback: string,
): string =>
  renderedSubject !== null && renderedSubject.trim().length > 0 ? renderedSubject : fallback;
