import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';

import { ICustomerErasureWriterPort } from '../../application/ports';
import { Customer } from '../../domain';
import { ConsentRecordEntity } from './consent-record.entity';
import { CustomerEntity } from './customer.entity';
import { CustomerMapper } from './customer.mapper';

@Injectable()
export class CustomerErasureWriterAdapter implements ICustomerErasureWriterPort {
  constructor(
    @InjectEntityManager()
    private readonly entityManager: EntityManager,
  ) {}

  public async persistErasure(customer: Customer): Promise<void> {
    await this.entityManager.transaction(async (manager: EntityManager) => {
      await manager.getRepository(CustomerEntity).save(CustomerMapper.toEntity(customer));

      await manager.query(
        `UPDATE address
            SET recipient_name = NULL,
                line1 = NULL,
                line2 = NULL,
                city = NULL,
                region = NULL,
                postal_code = NULL,
                phone = NULL,
                updated_at = CURRENT_TIMESTAMP
          WHERE owner_type = ? AND owner_id = ?`,
        ['customer', customer.id],
      );

      await manager.query(
        `UPDATE cart
            SET status = 'abandoned', version = version + 1, updated_at = CURRENT_TIMESTAMP
          WHERE customer_id = ? AND status = 'active'`,
        [customer.id],
      );

      await manager.getRepository(ConsentRecordEntity).delete({ customerId: customer.id });
    });
  }
}
