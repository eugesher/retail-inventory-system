import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { AUDIT_LOG_PUBLISHER, IAuditLogPublisher } from '@retail-inventory-system/contracts';

import { IEraseCustomerCommand } from '../dto';
import {
  CUSTOMER_ERASURE_WRITER,
  CUSTOMER_EVENTS_PUBLISHER,
  CUSTOMER_REPOSITORY,
  ICustomerErasureWriterPort,
  ICustomerEventsPublisherPort,
  ICustomerRepositoryPort,
} from '../ports';

// The result of an erase — the tombstone state the admin route returns. `erasedAt`
// is the ISO-8601 erase instant (`customer.deleted_at`), or null on the theoretical
// case of an already-`deleted` row that predates a `deletedAt` stamp.
export interface IEraseCustomerResult {
  status: 'deleted';
  erasedAt: string | null;
}

// The highest-sensitivity admin action: tombstone-erase a customer's PII (ADR-037
// §2). Erase is a **tombstone, never a hard delete** — the customer row is kept as
// `{ id, status: 'deleted', deletedAt }` with all PII nulled, so every
// `order.customer_id` FK stays valid and the sales history is intact and auditable
// (hard-deleting would orphan Orders — unacceptable for tax/dispute/accounting).
//
// The sequence (all side effects gated behind the not-found / idempotency /
// confirm-email checks):
//   1. Load the customer; not found → 404.
//   2. Idempotency: an already-`deleted` customer short-circuits with no re-audit,
//      re-emit, or second write (last-writer-wins). The confirm-email guard is
//      skipped here — there is no PII left to guard.
//   3. Confirm-email guard: the operator must type the customer's current email
//      (case-insensitive). Mismatch → 400, before any nulling.
//   4. Capture a PII-free before-snapshot `{ id, status }` for the audit.
//   5. `customer.erase(now)` nulls the PII in the aggregate.
//   6. The erasure writer persists it + nulls the `owner_type='customer'` address
//      PII + abandons the customer's carts, all in one transaction.
//   7. Audit (`AUDIT_LOG_PUBLISHER`) — before/after is the state transition only,
//      NO PII (capturing it would re-seed the durable audit log with the data the
//      erase removes, defeating itself — ADR-037 §4).
//   8. Emit `customer.erased` — ids + `erasedAt` only, again NO PII.
//
// The audit + emit run **after** the transaction commits, best-effort — a broker
// outage must never roll back a completed erase. The audit is ordered before the
// emit (the audit is the compliance record).
@Injectable()
export class EraseCustomerUseCase {
  constructor(
    @Inject(CUSTOMER_REPOSITORY)
    private readonly customers: ICustomerRepositoryPort,
    @Inject(CUSTOMER_ERASURE_WRITER)
    private readonly writer: ICustomerErasureWriterPort,
    @Inject(AUDIT_LOG_PUBLISHER)
    private readonly audit: IAuditLogPublisher,
    @Inject(CUSTOMER_EVENTS_PUBLISHER)
    private readonly events: ICustomerEventsPublisherPort,
  ) {}

  public async execute(command: IEraseCustomerCommand): Promise<IEraseCustomerResult> {
    const customer = await this.customers.findById(command.customerId);
    if (!customer) {
      throw new NotFoundException(`Customer ${command.customerId} not found`);
    }

    // Idempotency (ADR-037 §2, "erase is idempotent on a deleted customer,
    // last-writer-wins"): return the existing tombstone with no side effects. The
    // confirm-email guard is intentionally skipped — a deleted row has no email to
    // confirm against, and re-confirming a nulled email would be impossible.
    if (customer.status === 'deleted') {
      return {
        status: 'deleted',
        erasedAt: customer.deletedAt?.toISOString() ?? null,
      };
    }

    // Confirm-email guard (ADR-037; the operator-UX safety on an irreversible
    // action). Compare case-insensitively — the model lower-cases the stored email.
    // This runs BEFORE any nulling because the email is what we compare against.
    // The model already lower-cases the stored email; the optional chain guards the
    // (defensive) null case — a customer with no email can never be confirm-matched.
    const confirm = command.confirmEmail.trim().toLowerCase();
    if (customer.email?.toLowerCase() !== confirm) {
      throw new BadRequestException('confirmEmail does not match the customer’s current email');
    }

    // A PII-free before-snapshot for the audit — the state, not the data (§4).
    const before = { id: customer.id, status: customer.status };

    const erasedAt = new Date();
    customer.erase(erasedAt);
    await this.writer.persistErasure(customer);

    // Audit first (the compliance record), then the fan-out event — both post-commit,
    // best-effort. Neither carries PII: `before`/`after` is the state transition,
    // the event is ids + `erasedAt` only.
    await this.audit.publish({
      name: 'CustomerErased',
      actorId: command.actorStaffUserId,
      actorKind: 'staff',
      targetId: command.customerId,
      targetKind: 'customer',
      payload: { before, after: { status: 'deleted' } },
      correlationId: command.correlationId,
    });

    await this.events.publishErased({
      customerId: command.customerId,
      erasedAt,
      actorStaffUserId: command.actorStaffUserId,
      correlationId: command.correlationId,
    });

    return { status: 'deleted', erasedAt: erasedAt.toISOString() };
  }
}
