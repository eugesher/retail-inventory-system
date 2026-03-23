import * as dotenv from 'dotenv';
import * as mysql from 'mysql2/promise';
import * as path from 'path';

import { TestDbSeedUtil } from './utils';

for (const file of ['.env.local', '.env']) {
  const result = dotenv.config({ path: path.join(__dirname, '..', file) });
  if (result.parsed) break;
}

async function seed(): Promise<void> {
  const url = process.env.DATABASE_URL ?? 'mysql://retail:retailpass@localhost:3306/retail_db';
  const connection = await mysql.createConnection(url);

  try {
    for (const filename of TestDbSeedUtil.seedFiles) {
      const filePath = path.join(__dirname, 'seeds', filename);

      for (const statement of TestDbSeedUtil.readStatements(filePath)) {
        await connection.execute(statement);
      }
    }

    console.log('✓ Database seeded successfully');
  } finally {
    void connection.end();
  }
}

seed().catch((err: Error) => {
  console.error(`✗ Seed failed: ${err.message}`);
  process.exit(1);
});
