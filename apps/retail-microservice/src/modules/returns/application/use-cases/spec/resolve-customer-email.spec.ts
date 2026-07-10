import { PinoLogger } from 'nestjs-pino';

import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { resolveCustomerEmail } from '../resolve-customer-email';
import { FAKE_CUSTOMER_EMAIL, FakeReturnCustomerContactReader } from './test-doubles';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';

// The returns copy of the orders helper — a deliberate duplicate, because the returns
// bounded context may not import `orders/` (the boundaries lint, ADR-017). The behaviour it
// guarantees is identical, so the spec is too.
describe('resolveCustomerEmail (returns)', () => {
  let logger: PinoLoggerMock;

  beforeEach(() => {
    logger = makePinoLoggerMock();
  });

  it('resolves the reader’s email for a live customer', async () => {
    const reader = new FakeReturnCustomerContactReader();

    const email = await resolveCustomerEmail(
      reader,
      CUSTOMER_ID,
      logger as unknown as PinoLogger,
      'corr-1',
    );

    expect(email).toBe(FAKE_CUSTOMER_EMAIL);
    expect(reader.calls).toEqual([CUSTOMER_ID]);
  });

  it('returns null for a null customerId without consulting the reader', async () => {
    const reader = new FakeReturnCustomerContactReader();

    const email = await resolveCustomerEmail(
      reader,
      null,
      logger as unknown as PinoLogger,
      'corr-1',
    );

    expect(email).toBeNull();
    expect(reader.calls).toEqual([]);
  });

  it('returns null for an empty customerId without consulting the reader', async () => {
    const reader = new FakeReturnCustomerContactReader();

    const email = await resolveCustomerEmail(reader, '', logger as unknown as PinoLogger, 'corr-1');

    expect(email).toBeNull();
    expect(reader.calls).toEqual([]);
  });

  it('returns null when the reader resolves no row', async () => {
    const reader = new FakeReturnCustomerContactReader(FAKE_CUSTOMER_EMAIL, false);

    const email = await resolveCustomerEmail(
      reader,
      CUSTOMER_ID,
      logger as unknown as PinoLogger,
      'corr-1',
    );

    expect(email).toBeNull();
  });

  // An erased customer keeps its row but with `email` nulled in place (ADR-037), a
  // different path from "no row at all".
  it('returns null when the resolved row has a nulled email', async () => {
    const reader = new FakeReturnCustomerContactReader(null);

    const email = await resolveCustomerEmail(
      reader,
      CUSTOMER_ID,
      logger as unknown as PinoLogger,
      'corr-1',
    );

    expect(email).toBeNull();
  });

  // The contract the doc comment states in bold: **never throws**. This runs on the
  // post-commit emit path, so a reader hiccup must degrade to `customerEmail: null`
  // rather than fail an RMA transition that already committed.
  it('swallows a reader failure, warn-logs it, and degrades to null', async () => {
    const reader = new FakeReturnCustomerContactReader();
    const failure = new Error('connection reset');
    jest.spyOn(reader, 'findContactByCustomerId').mockRejectedValue(failure);

    const email = await resolveCustomerEmail(
      reader,
      CUSTOMER_ID,
      logger as unknown as PinoLogger,
      'corr-1',
    );

    expect(email).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: failure, correlationId: 'corr-1', customerId: CUSTOMER_ID }),
      expect.stringContaining('Failed to resolve customer email'),
    );
  });
});
