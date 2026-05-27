import * as argon2 from 'argon2';
import * as dotenv from 'dotenv';
import * as mysql from 'mysql2/promise';
import * as path from 'path';

import { PermissionCodeEnum } from '@retail-inventory-system/contracts';

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

// Stable UUIDs so test fixtures and assertions can rely on them. UUID
// prefixes namespace the seed type:
//   ...-a000-... → users
//   ...-b000-... → permissions
//   ...-c000-... → roles
const PERMISSION_SEEDS: { id: string; code: PermissionCodeEnum; description: string }[] = [
  {
    id: '00000000-0000-4000-b000-000000000001',
    code: PermissionCodeEnum.CATALOG_READ,
    description: 'Read catalog',
  },
  {
    id: '00000000-0000-4000-b000-000000000002',
    code: PermissionCodeEnum.CATALOG_WRITE,
    description: 'Create or update catalog items',
  },
  {
    id: '00000000-0000-4000-b000-000000000003',
    code: PermissionCodeEnum.CATALOG_PUBLISH,
    description: 'Publish catalog items',
  },
  {
    id: '00000000-0000-4000-b000-000000000004',
    code: PermissionCodeEnum.INVENTORY_READ,
    description: 'Read inventory levels',
  },
  {
    id: '00000000-0000-4000-b000-000000000005',
    code: PermissionCodeEnum.INVENTORY_ADJUST,
    description: 'Adjust inventory quantities',
  },
  {
    id: '00000000-0000-4000-b000-000000000006',
    code: PermissionCodeEnum.INVENTORY_TRANSFER,
    description: 'Transfer inventory between storages',
  },
  {
    id: '00000000-0000-4000-b000-000000000007',
    code: PermissionCodeEnum.ORDER_READ,
    description: 'Read orders',
  },
  {
    id: '00000000-0000-4000-b000-000000000008',
    code: PermissionCodeEnum.ORDER_CANCEL,
    description: 'Cancel orders',
  },
  {
    id: '00000000-0000-4000-b000-000000000009',
    code: PermissionCodeEnum.ORDER_REFUND,
    description: 'Refund orders',
  },
  {
    id: '00000000-0000-4000-b000-00000000000a',
    code: PermissionCodeEnum.IAM_ASSIGN,
    description: 'Assign roles to staff users',
  },
  {
    id: '00000000-0000-4000-b000-00000000000b',
    code: PermissionCodeEnum.IAM_ROLE_EDIT,
    description: 'Edit role-permission bindings',
  },
  {
    id: '00000000-0000-4000-b000-00000000000c',
    code: PermissionCodeEnum.AUDIT_READ,
    description: 'Read audit log',
  },
];

const ROLE_SEEDS: {
  id: string;
  name: string;
  description: string;
  permissions: PermissionCodeEnum[];
}[] = [
  {
    id: '00000000-0000-4000-c000-000000000001',
    name: 'admin',
    description: 'Full access to every permission code',
    permissions: Object.values(PermissionCodeEnum),
  },
  {
    id: '00000000-0000-4000-c000-000000000002',
    name: 'catalog-manager',
    description: 'Manage catalog content',
    permissions: [
      PermissionCodeEnum.CATALOG_READ,
      PermissionCodeEnum.CATALOG_WRITE,
      PermissionCodeEnum.CATALOG_PUBLISH,
    ],
  },
  {
    id: '00000000-0000-4000-c000-000000000003',
    name: 'warehouse-staff',
    description: 'Operate inventory at a warehouse',
    permissions: [
      PermissionCodeEnum.INVENTORY_READ,
      PermissionCodeEnum.INVENTORY_ADJUST,
      PermissionCodeEnum.INVENTORY_TRANSFER,
    ],
  },
  {
    id: '00000000-0000-4000-c000-000000000004',
    name: 'order-support',
    description: 'Handle order support workflows',
    permissions: [
      PermissionCodeEnum.ORDER_READ,
      PermissionCodeEnum.ORDER_CANCEL,
      PermissionCodeEnum.ORDER_REFUND,
    ],
  },
];

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

async function seedPermissions(connection: mysql.Connection): Promise<void> {
  for (const perm of PERMISSION_SEEDS) {
    await connection.execute(
      'INSERT IGNORE INTO permission (id, code, description) VALUES (?, ?, ?)',
      [perm.id, perm.code, perm.description],
    );
  }
}

async function seedRoles(connection: mysql.Connection): Promise<void> {
  const codeToId = new Map(PERMISSION_SEEDS.map((p) => [p.code, p.id] as const));

  for (const role of ROLE_SEEDS) {
    await connection.execute('INSERT IGNORE INTO role (id, name, description) VALUES (?, ?, ?)', [
      role.id,
      role.name,
      role.description,
    ]);

    for (const code of role.permissions) {
      const permissionId = codeToId.get(code);
      if (!permissionId) {
        throw new Error(`seedRoles: missing permission id for code ${code}`);
      }
      await connection.execute(
        'INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
        [role.id, permissionId],
      );
    }
  }
}

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

    await seedPermissions(connection);
    await seedRoles(connection);
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
