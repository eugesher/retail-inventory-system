import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as mysql from 'mysql2/promise';
import * as path from 'path';

// Mirror data-source.ts: try .env.local first, fall back to .env
for (const file of ['.env.local', '.env']) {
  const result = dotenv.config({ path: path.join(__dirname, '..', file) });
  if (result.parsed) break;
}

// ── Seed layout (IDs after fresh migration + this seed) ──────────────────────
//
//  Products:  1=Alpha(stock 5), 2=Beta(stock 3), 3=Gamma(stock 2), 4=Delta(no stock)
//  Customer:  1
//  Orders:    1=PENDING(full confirm), 2=PENDING(partial), 3=PENDING(no-stock), 4=CONFIRMED
//  OrderProducts:
//    Order 1 → op-id 1(Alpha), op-id 2(Alpha), op-id 3(Beta)
//    Order 2 → op-id 4(Gamma), op-id 5(Gamma), op-id 6(Gamma)  ← only 2 units available
//    Order 3 → op-id 7(Delta)
//    Order 4 → op-id 8(Alpha, already confirmed)

// Files are executed in order; later files may depend on earlier ones.
const SEED_FILES = [
  'product.sql',
  'customer.sql',
  'product-stock.sql',
  'order.sql',
  'order-product.sql',
];

function parseStatements(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, '')) // strip inline and standalone comments
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function seed(): Promise<void> {
  const url = process.env.DATABASE_URL ?? 'mysql://retail:retailpass@localhost:3306/retail_db';
  const connection = await mysql.createConnection(url);

  try {
    for (const file of SEED_FILES) {
      const filePath = path.join(__dirname, 'seeds', file);
      const sql = fs.readFileSync(filePath, 'utf8');
      for (const statement of parseStatements(sql)) {
        await connection.execute(statement);
      }
    }
    console.log('✓ Database seeded successfully');
  } finally {
    await connection.end();
  }
}

seed().catch((err) => {
  console.error('✗ Seed failed:', err);
  process.exit(1);
});
