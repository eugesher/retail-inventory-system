import { EntityManager } from 'typeorm';

import { ITransactionScope } from '@retail-inventory-system/ddd';
import { entityManagerOf, TypeormTransactionAdapter } from '../typeorm-transaction.adapter';

describe('TypeormTransactionAdapter', () => {
  it('forwards the EntityManager handed back by transaction(...) as the opaque scope', async () => {
    const innerEm = { kind: 'inner-em' } as unknown as EntityManager;
    const transaction = jest.fn((callback: (em: EntityManager) => unknown) =>
      Promise.resolve(callback(innerEm)),
    );
    const adapter = new TypeormTransactionAdapter({
      transaction,
    } as unknown as EntityManager);

    let receivedScope: ITransactionScope | undefined;
    const result = await adapter.runInTransaction((scope) => {
      receivedScope = scope;
      return Promise.resolve('ok');
    });

    expect(result).toBe('ok');
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(receivedScope as unknown).toBe(innerEm);
  });

  it('propagates errors thrown inside the work callback (rollback semantics)', async () => {
    const innerEm = {} as EntityManager;
    const txErr = new Error('mid-tx-fail');
    const transaction = jest.fn(async (callback: (em: EntityManager) => unknown) => {
      await callback(innerEm);
    });
    const adapter = new TypeormTransactionAdapter({
      transaction,
    } as unknown as EntityManager);

    await expect(adapter.runInTransaction(() => Promise.reject(txErr))).rejects.toBe(txErr);

    expect(transaction).toHaveBeenCalledTimes(1);
  });

  // The two halves of the downcast are one contract: what `runInTransaction` mints,
  // `entityManagerOf` must hand back unchanged — the very manager the transaction is running on,
  // or a repository that joins the scope would silently write outside it.
  it('entityManagerOf un-opaques a scope back to the manager it was minted from', async () => {
    const innerEm = { kind: 'inner-em' } as unknown as EntityManager;
    const transaction = jest.fn((callback: (em: EntityManager) => unknown) =>
      Promise.resolve(callback(innerEm)),
    );
    const adapter = new TypeormTransactionAdapter({
      transaction,
    } as unknown as EntityManager);

    const unwrapped = await adapter.runInTransaction((scope) =>
      Promise.resolve(entityManagerOf(scope)),
    );

    expect(unwrapped).toBe(innerEm);
  });
});
