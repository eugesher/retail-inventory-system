import * as fs from 'fs';

export class TestDbSeedUtil {
  public static seedFiles: string[] = [
    'product-stock.sql',
    'order.sql',
    'order-product.sql',
    'catalog-product.sql',
    'catalog-product-variant.sql',
    // After the variants: tax_category has no FK dependency, and price.variant_id
    // references product_variant.id, so both must follow catalog-product-variant.sql.
    'tax-category.sql',
    'price.sql',
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
