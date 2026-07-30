import { PinoLogger } from 'nestjs-pino';

import { IReturnCustomerContactReaderPort } from '../ports';

// Resolves a customer's notification email for a producer-side return event (ADR-033): a
// `null`/empty `customerId` is `null` without a read; otherwise the raw-SQL
// `RETURN_CUSTOMER_CONTACT_READER` resolves it (a missing row → `null`).
//
// **Never throws.** The email is a best-effort enrichment on the post-commit emit path — the
// RMA transition has already committed, so a reader hiccup must not fail a completed
// operation. A failure is warn-logged and the event ships with `customerEmail: null`.
//
// This is a deliberate local copy of the orders module's `resolveCustomerEmail`: the returns
// bounded context cannot import the orders module (the boundaries lint, ADR-017), so the
// one-place-per-module posture is duplicated rather than shared across the isolation line
// (ADR-032). It stays a copy because its first parameter is
// `IReturnCustomerContactReaderPort` — a module-owned type, which a shared lib may not
// name. `retryThenLogForReplay` had no such parameter and was lifted (ADR-056); that is the
// line between the two, not the size of the file.
export async function resolveCustomerEmail(
  reader: IReturnCustomerContactReaderPort,
  customerId: string | null,
  logger: PinoLogger,
  correlationId: string,
): Promise<string | null> {
  if (!customerId) {
    return null;
  }
  try {
    const contact = await reader.findContactByCustomerId(customerId);
    return contact?.email ?? null;
  } catch (error) {
    logger.warn(
      { err: error as Error, correlationId, customerId },
      'Failed to resolve customer email for the event (continuing with null)',
    );
    return null;
  }
}
