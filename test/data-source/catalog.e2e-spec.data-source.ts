import { DataSource } from 'typeorm';

// E2E helper for the catalog flow. The publish precondition requires every
// variant to have an in-effect Price in the default currency, so the happy-path
// publish test seeds one open price per variant directly via SQL — the same
// SQL-seed approach the test database seed uses for active products, and the
// only price-write path available before the gateway pricing routes exist. The
// open price (`valid_to NULL`, `valid_from = now`) is exactly what the catalog
// publish probe reads back.
export class CatalogE2ESpecDataSource extends DataSource {
  public async insertActivePrice(
    variantId: number,
    currency: string,
    amountMinor: number,
  ): Promise<any> {
    return await this.query(
      `
        INSERT INTO price (variant_id, currency, amount_minor, valid_from)
        VALUES (?, ?, ?, UTC_TIMESTAMP());
      `,
      [variantId, currency, amountMinor],
    );
  }
}
