import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(root, 'config.js');

try {
  await access(configPath);
} catch {
  console.error('[verify] config.js not found. Run: npm run build (with SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY)');
  process.exit(1);
}

const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = await import(pathToFileURL(configPath).href);
if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  console.error('[verify] config.js is missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY.');
  process.exit(1);
}

const tables = ['profiles', 'projects', 'cases', 'tasks', 'reports', 'attachments'];
let missing = 0;

for (const table of tables) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=id&limit=1`;
  let status = 0;
  let body = '';
  try {
    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
      },
    });
    status = res.status;
    body = await res.text();
  } catch (err) {
    console.log(`FAIL ${table}: ${err.message}`);
    missing++;
    continue;
  }

  if (status === 200 || status === 206) {
    console.log(`OK   ${table} (HTTP ${status})`);
  } else if (status === 404) {
    console.log(`MISS ${table} (HTTP 404, table not created)`);
    missing++;
  } else {
    console.log(`WARN ${table} (HTTP ${status}) ${body.slice(0, 160)}`);
    missing++;
  }
}

if (missing) {
  console.log(`\n${missing}/${tables.length} tables are not ready.`);
  console.log('Run supabase/migrations/0001_init.sql in Supabase SQL Editor, then retry.');
  process.exit(1);
}

console.log(`\nAll ${tables.length} tables are reachable with the publishable key.`);
