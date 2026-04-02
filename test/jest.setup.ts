// REVIEW-FIX: CONF-008 — load from .env.local instead of duplicating values
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });

process.env.NODE_ENV = 'test';
process.env.DATABASE_LOGGING = 'false';
