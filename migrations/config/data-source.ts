import * as dotenv from 'dotenv';
import * as Joi from 'joi';
import * as path from 'path';
import { DataSource } from 'typeorm';

for (const relative of ['../../.env.local', '../../.env']) {
  const result = dotenv.config({ path: path.join(__dirname, relative) });

  if (result.parsed) {
    break;
  }
}

const schema = Joi.object().keys({ DATABASE_URL: Joi.string().required() }).unknown();
const result = schema.validate(process.env);

if (result.error) {
  throw new Error(`Config validation error: ${result.error.message}`);
}

export default new DataSource({
  type: 'mysql',
  url: result.value['DATABASE_URL'],
  migrations: [path.join(__dirname, '../*{.ts,.js}')],
});
