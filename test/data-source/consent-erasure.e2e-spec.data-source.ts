import { InventoryAutoInitE2ESpecDataSource } from './inventory-auto-init.e2e-spec.data-source';

export interface ICustomerRowProjection {
  id: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  passwordHash: string | null;
  status: string;
  refreshTokenHash: string | null;
  deletedAt: Date | null;
}

export interface IAddressRowProjection {
  id: string;
  ownerType: string;
  ownerId: string;
  recipientName: string | null;
  line1: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string;
}

export interface ICartRowProjection {
  id: string;
  status: string;
}

export interface IConsentRowProjection {
  customerId: string;
  transactionalEmail: boolean;
  marketingEmail: boolean;
  marketingSms: boolean;
  dataRetentionPolicy: string;
}

export class ConsentErasureE2ESpecDataSource extends InventoryAutoInitE2ESpecDataSource {
  public async getCustomerById(id: string): Promise<ICustomerRowProjection | undefined> {
    const rows: Record<string, unknown>[] = await this.query(
      `
        SELECT id, email, phone, first_name, last_name, password_hash, status,
               refresh_token_hash, deleted_at
        FROM customer
        WHERE id = ?
        LIMIT 1;
      `,
      [id],
    );
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return {
      id: String(row.id),
      email: (row.email as string | null) ?? null,
      phone: (row.phone as string | null) ?? null,
      firstName: (row.first_name as string | null) ?? null,
      lastName: (row.last_name as string | null) ?? null,
      passwordHash: (row.password_hash as string | null) ?? null,
      status: String(row.status),
      refreshTokenHash: (row.refresh_token_hash as string | null) ?? null,
      deletedAt: (row.deleted_at as Date | null) ?? null,
    };
  }

  public async getAddressesByOwner(
    ownerType: string,
    ownerId: string,
  ): Promise<IAddressRowProjection[]> {
    const rows: Record<string, unknown>[] = await this.query(
      `
        SELECT id, owner_type, owner_id, recipient_name, line1, city, region,
               postal_code, country
        FROM address
        WHERE owner_type = ? AND owner_id = ?
        ORDER BY id;
      `,
      [ownerType, ownerId],
    );
    return rows.map((row) => ({
      id: String(row.id),
      ownerType: String(row.owner_type),
      ownerId: String(row.owner_id),
      recipientName: (row.recipient_name as string | null) ?? null,
      line1: (row.line1 as string | null) ?? null,
      city: (row.city as string | null) ?? null,
      region: (row.region as string | null) ?? null,
      postalCode: (row.postal_code as string | null) ?? null,
      country: String(row.country),
    }));
  }

  public async getCartsByCustomerId(customerId: string): Promise<ICartRowProjection[]> {
    const rows: Record<string, unknown>[] = await this.query(
      `
        SELECT id, status
        FROM cart
        WHERE customer_id = ?
        ORDER BY id;
      `,
      [customerId],
    );
    return rows.map((row) => ({
      id: String(row.id),
      status: String(row.status),
    }));
  }

  public async getConsentByCustomerId(
    customerId: string,
  ): Promise<IConsentRowProjection | undefined> {
    const rows: Record<string, unknown>[] = await this.query(
      `
        SELECT customer_id, transactional_email, marketing_email, marketing_sms,
               data_retention_policy
        FROM consent_record
        WHERE customer_id = ?
        LIMIT 1;
      `,
      [customerId],
    );
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return {
      customerId: String(row.customer_id),
      transactionalEmail: Number(row.transactional_email) === 1,
      marketingEmail: Number(row.marketing_email) === 1,
      marketingSms: Number(row.marketing_sms) === 1,
      dataRetentionPolicy: String(row.data_retention_policy),
    };
  }
}
