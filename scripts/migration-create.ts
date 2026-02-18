import { execSync } from 'child_process';
import { join, resolve } from 'path';

const name = process.argv[2];

if (!name) {
  console.error('Migration name is not specified.');
  process.exit(1);
}

const dir = resolve('migrations');
const path = join(dir, name);

execSync(`ts-node -r tsconfig-paths/register ./node_modules/typeorm/cli migration:create ${path}`, {
  stdio: 'inherit',
});
