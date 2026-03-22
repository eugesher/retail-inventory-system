export class TestDbSeedUtil {
  public static seedFiles = [
    'product.sql',
    'customer.sql',
    'product-stock.sql',
    'order.sql',
    'order-product.sql',
  ];

  public static parseSqlStatements(sql: string): string[] {
    return sql
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
}
