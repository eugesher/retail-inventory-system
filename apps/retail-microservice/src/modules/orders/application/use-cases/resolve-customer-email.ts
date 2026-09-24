import { PinoLogger } from 'nestjs-pino';

import { IOrderCustomerContactReaderPort } from '../ports';

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
