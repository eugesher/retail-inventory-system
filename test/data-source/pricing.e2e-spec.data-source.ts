import { DataSource } from 'typeorm';

export class PricingE2ESpecDataSource extends DataSource {
  public async countOpenPrices(variantId: number, currency: string): Promise<number> {
    const rows = (await this.query(
      `
        SELECT COUNT(*) AS open_count
        FROM price
        WHERE variant_id = ?
          AND currency = ?
          AND valid_to IS NULL;
      `,
      [variantId, currency],
    )) as { open_count: number | string }[];

    return Number(rows[0]?.open_count ?? 0);
  }
}
