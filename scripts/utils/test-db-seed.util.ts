import * as fs from 'fs';

export class TestDbSeedUtil {
  public static seedFiles: string[] = [
    'catalog-product.sql',
    'catalog-product-variant.sql',
    // After the variants: tax_category has no FK dependency, and price.variant_id
    // references product_variant.id, so both must follow catalog-product-variant.sql.
    'tax-category.sql',
    'price.sql',
    // stock_level.variant_id references product_variant.id, so this also follows
    // catalog-product-variant.sql; stock_location ('default-warehouse') comes from
    // the migration, not a seed.
    'stock-level.sql',
    // The example cart FKs the seeded customer (seeded by the JS identity pass,
    // which runs before these SQL files), product_variant (catalog-product-variant.sql),
    // and snapshots the variant's price (price.sql) — so it must come last.
    'cart.sql',
  ];

  public static readStatements(filePath: string): string[] {
    const sql = fs.readFileSync(filePath, 'utf8');

    return TestDbSeedUtil.parseSqlStatements(sql);
  }

  public static parseSqlStatements(sql: string): string[] {
    return sql
      .replace(/--[^\n]*/g, '')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
}
