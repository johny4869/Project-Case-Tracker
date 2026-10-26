import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const js = readFileSync(resolve(root, 'app.js'), 'utf8');

const htmlIds = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
const dynamicIds = new Set(['logoutBtn', 'modal', 'modalForm', 'attachmentList', 'attachInput']);
const referenced = new Set();
for (const m of js.matchAll(/\$\('#([\w-]+)'/g)) referenced.add(m[1]);

const missing = [...referenced].filter((id) => !htmlIds.has(id) && !dynamicIds.has(id));
if (missing.length) {
  console.error('Missing element ids referenced from app.js:', missing);
  process.exit(1);
}

const tabNames = ['projects', 'cases', 'tasks', 'files', 'reports', 'settings'];
const missingTabs = tabNames.filter((t) => !htmlIds.has(`${t}-tab`));
if (missingTabs.length) {
  console.error('Missing tab sections:', missingTabs);
  process.exit(1);
}

console.log(`DOM check passed: ${referenced.size} selectors, ${tabNames.length} tabs.`);
