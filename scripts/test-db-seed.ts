import { Logger } from '@nestjs/common';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as mysql from 'mysql2/promise';
import * as path from 'path';

import { TestDbSeedUtil } from './utils';

((): void => {
  const logger = new Logger('TestDbSeed');

  logger.log('Preparing to seed test data');

  void (async (): Promise<void> => {
    for (const file of ['.env.local', '.env']) {
      const result = dotenv.config({ path: path.join(__dirname, '..', file) });
      if (result.parsed) break;
    }

    const url = process.env.DATABASE_URL ?? 'mysql://retail:retailpass@localhost:3306/retail_db';
    const connection = await mysql.createConnection(url);
    const filenames = TestDbSeedUtil.seedFiles;

    try {
      logger.log('Seeding test data');

      for (const filename of filenames) {
        const filePath = path.join(__dirname, 'seeds', filename);
        const sql = fs.readFileSync(filePath, 'utf8');
        const statements = TestDbSeedUtil.parseSqlStatements(sql);

        for (const statement of statements) {
          await connection.execute(statement);
        }
      }

      logger.log('✓ Database seeded successfully');
    } finally {
      void connection.end();
    }
  })().catch((err: Error) => {
    logger.error(`✗ Seed failed: ${err.message}`);

    process.exit(1);
  });
})();
