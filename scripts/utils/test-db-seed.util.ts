import * as fs from 'fs';

export class TestDbSeedUtil {
  public static seedFiles: string[] = [
    'catalog-product.sql',
    'catalog-product-variant.sql',
    // Category hierarchy, then the product↔category membership, then media.
    // category.sql has no FK to product; product-categories.sql references both
    // product (catalog-product.sql) and category (category.sql); media-asset.sql
    // references product 1 by opaque owner id (no FK). So the order within this
    // group is category -> product-categories -> media-asset, and the group
    // follows catalog-product(-variant).sql.
    'category.sql',
    'product-categories.sql',
    'media-asset.sql',
    // After the variants: tax_category has no FK dependency, and price.variant_id
    // references product_variant.id, so both must follow catalog-product-variant.sql.
    'tax-category.sql',
    'price.sql',
    // A second active stock location ('backup-store') so transfers have a
    // destination. It is independent of stock-level.sql (no FK from a stock level
    // seed targets it), but is registered before it so the destination exists for
    // any later fixture; 'default-warehouse' still comes from the migration.
    'stock-location.sql',
    // stock_level.variant_id references product_variant.id, so this also follows
    // catalog-product-variant.sql; stock_location ('default-warehouse') comes from
    // the migration, not a seed.
    'stock-level.sql',
    // The example cart FKs the seeded customer (seeded by the JS identity pass,
    // which runs before these SQL files), product_variant (catalog-product-variant.sql),
    // and snapshots the variant's price (price.sql) — so it must come last.
    'cart.sql',
    // One active v1 template per notification event type. No FK dependency
    // (notification_template references nothing; notification_delivery is not seeded),
    // so its position is free — placed last after the catalog/retail fixtures.
    'notification-template.sql',
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
