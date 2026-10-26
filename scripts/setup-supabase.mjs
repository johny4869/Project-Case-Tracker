import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ref = process.env.SUPABASE_PROJECT_REF || 'wcxeyohzvcbwhpclplfb';

let token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) {
  try {
    token = (await readFile(join(homedir(), '.supabase', 'access-token'), 'utf8')).trim();
  } catch {
    // handled below
  }
}

if (!token) {
  console.error('[setup] Missing Supabase access token.');
  console.error('[setup] Set SUPABASE_ACCESS_TOKEN (sbp_...) or write it to ~/.supabase/access-token.');
  console.error('[setup] Create one at https://supabase.com/dashboard/account/tokens (revoke it afterwards).');
  process.exit(1);
}

const sql = await readFile(resolve(root, 'supabase/migrations/0001_init.sql'), 'utf8');
const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ query: sql, read_only: false }),
});

const body = await res.text();
if (!res.ok) {
  console.error(`[setup] HTTP ${res.status}`);
  console.error(body.slice(0, 1500));
  process.exit(1);
}

console.log('[setup] Migration executed successfully.');
console.log(body.slice(0, 500));
console.log('[setup] Next: create a user in Authentication -> Users, then run npm run verify:supabase.');
