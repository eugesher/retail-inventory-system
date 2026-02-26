import { Logger } from '@nestjs/common';
import { execSync } from 'child_process';
import { join, resolve } from 'path';

((): void => {
  const name = process.argv[2];

  if (!name) {
    const logger = new Logger('MigrationCreate');

    logger.error('Migration name is not specified.');

    process.exit(1);
  }

  const dir = resolve('migrations');
  const path = join(dir, name);
  const command = `ts-node -r tsconfig-paths/register ./node_modules/typeorm/cli migration:create ${path}`;

  execSync(command, { stdio: 'inherit' });
})();
