import { PinoLogger } from 'nestjs-pino';

import { IOrderCustomerContactReaderPort } from '../ports';

// Resolves a customer's notification email for a producer-side wire event (ADR-033): a
// `null`/empty `customerId` (a tombstoned order) is `null` without a read; otherwise the
// raw-SQL `ORDER_CUSTOMER_CONTACT_READER` resolves it (a missing row → `null`).
//
// **Never throws.** The email is a best-effort enrichment on the post-commit emit path — the
// order has already committed, so a reader hiccup must not fail a completed operation. A
// failure is warn-logged and the event ships with `customerEmail: null` (the notification
// consumer then falls back to its own recipient resolution). The retry-then-log post-commit
// posture (ADR-031/032) for the same reason.
export async function resolveCustomerEmail(
  reader: IOrderCustomerContactReaderPort,
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
