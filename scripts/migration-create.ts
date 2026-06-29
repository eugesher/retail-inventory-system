import { Logger } from '@nestjs/common';
import { execSync } from 'child_process';
import { join, resolve } from 'path';

((): void => {
  const args = process.argv.slice(2);

  // An optional `--dir <subdir>` flag selects the migrations subfolder to scaffold
  // into — e.g. `--dir eventstore` targets `migrations/eventstore/` for the isolated
  // `ris_eventstore` schema (ADR-034). With no flag the target is the `migrations/`
  // root (the operational `retail_db`), so plain `migration:create` is unchanged.
  let subdir = '';
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir') {
      subdir = args[i + 1] ?? '';
      i++;
    } else {
      positional.push(args[i]);
    }
  }

  const name = positional[0];

  if (!name) {
    const logger = new Logger('MigrationCreate');

    logger.error('Migration name is not specified.');

    process.exit(1);
  }

  const dir = resolve('migrations', subdir);
  const path = join(dir, name);
  const command = `ts-node -r tsconfig-paths/register ./node_modules/typeorm/cli migration:create ${path}`;

  execSync(command, { stdio: 'inherit' });
})();
