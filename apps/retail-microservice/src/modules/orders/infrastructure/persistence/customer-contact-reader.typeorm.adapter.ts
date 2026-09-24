import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';

import { IOrderCustomerContact, IOrderCustomerContactReaderPort } from '../../application/ports';

interface ICustomerContactRow {
  email: string | null;
}

@Injectable()
export class CustomerContactReaderTypeormAdapter implements IOrderCustomerContactReaderPort {
  constructor(
    @InjectEntityManager()
    private readonly entityManager: EntityManager,
  ) {}

  public async findContactByCustomerId(customerId: string): Promise<IOrderCustomerContact | null> {
    const rows = await this.entityManager.query<ICustomerContactRow[]>(
      'SELECT email FROM customer WHERE id = ?',
      [customerId],
    );
    if (rows.length === 0) {
      return null;
    }
    return { email: rows[0].email ?? null };
  }
}
