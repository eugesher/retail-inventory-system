import { DataSource } from 'typeorm';

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
