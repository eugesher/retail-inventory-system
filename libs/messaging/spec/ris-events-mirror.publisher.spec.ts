import { ClientProxy } from '@nestjs/microservices';
import { PinoLogger } from 'nestjs-pino';
import { of, throwError } from 'rxjs';

import { ICorrelationPayload } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { RisEventsMirrorPublisher } from '../ris-events-mirror.publisher';

// The shared `ris.events` mirror seam every domain-event publisher reuses for the
// firehose dual-publish (ADR-035). These tests lock its two load-bearing
// guarantees at the source: it emits onto the topic-exchange client under the
// caller's routing key, and it **swallows its own rejection** (warn-log, no throw)
// so the dozens of call sites need no `try/catch`.
describe('RisEventsMirrorPublisher', () => {
  let emit: jest.Mock;
  let client: ClientProxy;
  let logger: PinoLoggerMock;
  let publisher: RisEventsMirrorPublisher;

  const payload: ICorrelationPayload = { correlationId: 'cid-1' };

  beforeEach(() => {
    emit = jest.fn().mockReturnValue(of(undefined));
    client = { emit } as unknown as ClientProxy;
    logger = makePinoLoggerMock();
    publisher = new RisEventsMirrorPublisher(client, logger as unknown as PinoLogger);
  });

  it('mirrors the routing key + payload onto the topic-exchange client', async () => {
    await publisher.mirror('retail.order.placed', payload);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('retail.order.placed', payload);
  });

  it('swallows a rejected emit (best-effort post-commit) and warn-logs it', async () => {
    emit.mockReturnValue(throwError(() => new Error('ris.events down')));

    await expect(publisher.mirror('retail.order.placed', payload)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
