import * as fs from 'fs';

export class TestDbSeedUtil {
  public static seedFiles: string[] = [
    'product.sql',
    'customer.sql',
    'product-stock.sql',
    'order.sql',
    'order-product.sql',
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
