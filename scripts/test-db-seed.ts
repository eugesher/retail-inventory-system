import * as argon2 from 'argon2';
import * as dotenv from 'dotenv';
import * as mysql from 'mysql2/promise';
import * as path from 'path';

import { TestDbSeedUtil } from './utils';

for (const file of ['.env.local', '.env']) {
  const result = dotenv.config({ path: path.join(__dirname, '..', file) });
  if (result.parsed) break;
}

interface ITestUserSeed {
  id: string;
  email: string;
  password: string;
  roles: string[];
}

// Stable UUIDs so test fixtures and assertions can rely on them.
const TEST_USERS: ITestUserSeed[] = [
  {
    id: '00000000-0000-4000-a000-000000000001',
    email: 'admin@example.com',
    password: 'admin1234',
    roles: ['admin', 'customer'],
  },
  {
    id: '00000000-0000-4000-a000-000000000002',
    email: 'customer@example.com',
    password: 'customer1234',
    roles: ['customer'],
  },
];

const argonOptions: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: Number(process.env.AUTH_ARGON2_MEMORY_COST ?? 19_456),
  timeCost: Number(process.env.AUTH_ARGON2_TIME_COST ?? 2),
  parallelism: Number(process.env.AUTH_ARGON2_PARALLELISM ?? 1),
};

async function seedUsers(connection: mysql.Connection): Promise<void> {
  for (const user of TEST_USERS) {
    const passwordHash = await argon2.hash(user.password, argonOptions);
    await connection.execute(
      `INSERT INTO user (id, email, password_hash, roles, refresh_token_hash)
       VALUES (?, ?, ?, ?, NULL)
       ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash),
                               roles = VALUES(roles),
                               refresh_token_hash = NULL`,
      [user.id, user.email, passwordHash, user.roles.join(',')],
    );
  }
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

    await seedUsers(connection);

    console.log('✓ Database seeded successfully');
  } finally {
    void connection.end();
  }
}

seed().catch((err: Error) => {
  console.error(`✗ Seed failed: ${err.message}`);
  process.exit(1);
});
