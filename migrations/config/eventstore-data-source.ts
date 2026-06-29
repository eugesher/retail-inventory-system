import * as dotenv from 'dotenv';
import * as Joi from 'joi';
import * as path from 'path';
import { DataSource } from 'typeorm';

// The second migration data-source — the isolated `ris_eventstore` schema (ADR-034),
// separate from the operational `retail_db` `data-source.ts` drives. It reads
// `EVENTSTORE_DATABASE_URL` and globs `migrations/eventstore/*` (NON-recursive, and
// disjoint from the main `migrations/*` glob), so each database keeps its own
// migration history table and the two `migration:run` families never interleave.
for (const relative of ['../../.env.local', '../../.env']) {
  const result = dotenv.config({ path: path.join(__dirname, relative) });

  if (result.parsed) {
    break;
  }
}

const schema = Joi.object().keys({ EVENTSTORE_DATABASE_URL: Joi.string().required() }).unknown();
const result = schema.validate(process.env);

if (result.error) {
  throw new Error(`Config validation error: ${result.error.message}`);
}

export default new DataSource({
  type: 'mysql',
  url: result.value['EVENTSTORE_DATABASE_URL'],
  migrations: [path.join(__dirname, '../eventstore/*{.ts,.js}')],
});
