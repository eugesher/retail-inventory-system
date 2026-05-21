import { EntityManager } from 'typeorm';

import { ITransactionScope } from '../../../application/ports';
import { TypeormTransactionAdapter } from '../typeorm-transaction.adapter';

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
    // The scope handed to the work callback is the EntityManager TypeORM
    // provided — type-erased to ITransactionScope at the seam.
    expect(receivedScope as unknown).toBe(innerEm);
  });

  it('propagates errors thrown inside the work callback (rollback semantics)', async () => {
    const innerEm = {} as EntityManager;
    const txErr = new Error('mid-tx-fail');
    // Mirror the production behavior: when the inner callback rejects,
    // TypeORM's `transaction` returns a rejected promise and never commits.
    const transaction = jest.fn(async (callback: (em: EntityManager) => unknown) => {
      await callback(innerEm);
    });
    const adapter = new TypeormTransactionAdapter({
      transaction,
    } as unknown as EntityManager);

    await expect(adapter.runInTransaction(() => Promise.reject(txErr))).rejects.toBe(txErr);

    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
