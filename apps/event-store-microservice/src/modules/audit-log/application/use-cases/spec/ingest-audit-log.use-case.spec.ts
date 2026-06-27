import { PinoLogger } from 'nestjs-pino';

import { IAuditStaffActionEvent } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { AuditLogEntry } from '../../../domain';
import { IAuditLogAppendResult, IAuditLogRepositoryPort } from '../../ports';
import { IngestAuditLogUseCase } from '../ingest-audit-log.use-case';

// A fake audit repository recording every appended entry; programmable to throw.
class FakeAuditLogRepository implements IAuditLogRepositoryPort {
  public readonly appended: AuditLogEntry[] = [];
  private throwOnAppend: Error | null = null;

  public programThrow(error: Error): void {
    this.throwOnAppend = error;
  }

  public append(entry: AuditLogEntry): Promise<IAuditLogAppendResult> {
    if (this.throwOnAppend) {
      return Promise.reject(this.throwOnAppend);
    }
    this.appended.push(entry);
    return Promise.resolve({ inserted: true });
  }

  public listByActor(): Promise<AuditLogEntry[]> {
    return Promise.resolve([]);
  }
}

const OCCURRED_AT = '2026-06-27T10:00:00.000Z';

const auditEvent = (overrides: Partial<IAuditStaffActionEvent> = {}): IAuditStaffActionEvent => ({
  actorId: 'staff-1',
  actorType: 'staff-user',
  action: 'StaffUserRolesAssigned',
  entityType: 'staff-user',
  entityId: 'staff-7',
  before: { roles: ['viewer'] },
  after: { roles: ['viewer', 'admin'] },
  occurredAt: OCCURRED_AT,
  ipAddress: null,
  eventVersion: 'v1',
  correlationId: 'corr-audit-1',
  ...overrides,
});

describe('IngestAuditLogUseCase', () => {
  let repository: FakeAuditLogRepository;
  let logger: ReturnType<typeof makePinoLoggerMock>;
  let useCase: IngestAuditLogUseCase;

  beforeEach(() => {
    repository = new FakeAuditLogRepository();
    logger = makePinoLoggerMock();
    useCase = new IngestAuditLogUseCase(repository, logger as unknown as PinoLogger);
  });

  it('maps an IAuditStaffActionEvent 1:1 to an audit_log_entry row (happy path)', async () => {
    await useCase.execute(auditEvent());

    expect(repository.appended).toHaveLength(1);
    const [entry] = repository.appended;
    expect(entry.actorId).toBe('staff-1');
    expect(entry.actorType).toBe('staff-user');
    expect(entry.action).toBe('StaffUserRolesAssigned');
    expect(entry.entityType).toBe('staff-user');
    expect(entry.entityId).toBe('staff-7');
    expect(entry.before).toEqual({ roles: ['viewer'] });
    expect(entry.after).toEqual({ roles: ['viewer', 'admin'] });
    expect(entry.occurredAt.toISOString()).toBe(OCCURRED_AT);
    expect(entry.ipAddress).toBeNull();
    expect(entry.correlationId).toBe('corr-audit-1');
  });

  it('persists a system-origin event with a null actor (e.g. auto-refund-from-cancel)', async () => {
    await useCase.execute(
      auditEvent({ actorId: null, actorType: 'system', action: 'RefundIssued' }),
    );

    expect(repository.appended).toHaveLength(1);
    expect(repository.appended[0].actorId).toBeNull();
    expect(repository.appended[0].actorType).toBe('system');
  });

  it('drops an event whose actorType is outside {staff-user, system} (warn, no append)', async () => {
    await useCase.execute(
      auditEvent({ actorType: 'robot' as unknown as IAuditStaffActionEvent['actorType'] }),
    );

    expect(repository.appended).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('drops an event with an unparseable occurredAt (warn, no append)', async () => {
    await useCase.execute(auditEvent({ occurredAt: 'not-a-date' }));

    expect(repository.appended).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('swallows a thrown repository error — never rethrows from the consumer path', async () => {
    repository.programThrow(new Error('connection reset'));

    await expect(useCase.execute(auditEvent())).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
