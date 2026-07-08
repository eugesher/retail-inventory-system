import { EntityManager } from 'typeorm';

import { Customer } from '../../../domain';
import { ConsentRecordEntity } from '../consent-record.entity';
import { CustomerEntity } from '../customer.entity';
import { CustomerErasureWriterAdapter } from '../customer-erasure-writer.adapter';

const CUSTOMER_ID = 'cccccccc-cccc-4ccc-accc-cccccccccccc';

interface ICapturedQuery {
  sql: string;
  params?: unknown[];
}

interface ICapturedDelete {
  target: unknown;
  criteria: unknown;
}

interface IRepositoryDouble {
  save: (entity: unknown) => Promise<unknown>;
  delete: (criteria: unknown) => Promise<unknown>;
}

// A hand-rolled EntityManager double: `transaction(cb)` runs the callback with a
// transactional manager that records `getRepository().save()` / `.delete()` calls
// and `query()` calls, so the spec can assert the exact SQL + bound params the
// adapter issues — in particular that the address UPDATE targets
// `owner_type='customer'` only, and that the consent record is deleted.
const buildManagerDouble = (): {
  entityManager: EntityManager;
  saved: unknown[];
  deletes: ICapturedDelete[];
  queries: ICapturedQuery[];
} => {
  const saved: unknown[] = [];
  const deletes: ICapturedDelete[] = [];
  const queries: ICapturedQuery[] = [];

  const makeRepositoryDouble = (target: unknown): IRepositoryDouble => ({
    save: (entity: unknown): Promise<unknown> => {
      saved.push(entity);
      return Promise.resolve(entity);
    },
    delete: (criteria: unknown): Promise<unknown> => {
      deletes.push({ target, criteria });
      return Promise.resolve({ affected: 1 });
    },
  });
  const txManager = {
    getRepository: (target: unknown): IRepositoryDouble => makeRepositoryDouble(target),
    query: (sql: string, params?: unknown[]): Promise<unknown[]> => {
      queries.push({ sql, params });
      return Promise.resolve([]);
    },
  };

  const entityManager = {
    transaction: (cb: (m: unknown) => Promise<unknown>): Promise<unknown> => cb(txManager),
  } as unknown as EntityManager;

  return { entityManager, saved, deletes, queries };
};

const makeErasedCustomer = (): Customer => {
  const customer = Customer.register(CUSTOMER_ID, {
    email: 'buyer@example.com',
    passwordHash: 'argon2-hash',
    status: 'active',
    phone: '+1-555-0100',
    firstName: 'Buy',
    lastName: 'Er',
    refreshTokenHash: 'live-token-hash',
  });
  customer.erase(new Date('2026-07-05T12:00:00.000Z'));
  return customer;
};

describe('CustomerErasureWriterAdapter', () => {
  it('persists the erased customer row with nulled PII', async () => {
    const { entityManager, saved } = buildManagerDouble();
    const adapter = new CustomerErasureWriterAdapter(entityManager);

    await adapter.persistErasure(makeErasedCustomer());

    expect(saved).toHaveLength(1);
    const row = saved[0] as Partial<CustomerEntity>;
    expect(row.id).toBe(CUSTOMER_ID);
    expect(row.status).toBe('deleted');
    expect(row.email).toBeNull();
    expect(row.phone).toBeNull();
    expect(row.firstName).toBeNull();
    expect(row.lastName).toBeNull();
    expect(row.passwordHash).toBeNull();
    expect(row.refreshTokenHash).toBeNull();
    expect(row.deletedAt).not.toBeNull();
  });

  it('nulls only the owner_type="customer" address PII', async () => {
    const { entityManager, queries } = buildManagerDouble();
    const adapter = new CustomerErasureWriterAdapter(entityManager);

    await adapter.persistErasure(makeErasedCustomer());

    const addressUpdate = queries.find((q) => /UPDATE\s+address/i.test(q.sql));
    expect(addressUpdate).toBeDefined();
    // The discriminator is bound to 'customer' — order-snapshot rows are never touched.
    expect(addressUpdate!.params).toEqual(['customer', CUSTOMER_ID]);
    expect(addressUpdate!.sql).toMatch(/owner_type\s*=\s*\?/i);
    expect(addressUpdate!.sql).toMatch(/recipient_name\s*=\s*NULL/i);
    // country is NOT nulled (a non-identifying region code).
    expect(addressUpdate!.sql).not.toMatch(/country\s*=\s*NULL/i);
  });

  it('abandons only the customer’s active carts', async () => {
    const { entityManager, queries } = buildManagerDouble();
    const adapter = new CustomerErasureWriterAdapter(entityManager);

    await adapter.persistErasure(makeErasedCustomer());

    const cartUpdate = queries.find((q) => /UPDATE\s+cart/i.test(q.sql));
    expect(cartUpdate).toBeDefined();
    expect(cartUpdate!.params).toEqual([CUSTOMER_ID]);
    expect(cartUpdate!.sql).toMatch(/status\s*=\s*'abandoned'/i);
    expect(cartUpdate!.sql).toMatch(/status\s*=\s*'active'/i);
  });

  it('deletes the customer’s consent record (GDPR erasure of consent PII)', async () => {
    const { entityManager, deletes } = buildManagerDouble();
    const adapter = new CustomerErasureWriterAdapter(entityManager);

    await adapter.persistErasure(makeErasedCustomer());

    // The consent record is deleted in the same transaction, so it does not survive
    // the tombstone (its FK CASCADE never fires on a non-hard-delete). A later consent
    // read then falls through to the absent-row defaults (marketing denied), which is
    // what the `customer.erased` cache-eviction consumer relies on.
    const consentDelete = deletes.find((d) => d.target === ConsentRecordEntity);
    expect(consentDelete).toBeDefined();
    expect(consentDelete!.criteria).toEqual({ customerId: CUSTOMER_ID });
  });
});
