import http from 'node:http';
import { readFile, access } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.cwd());
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent((req.url || '/').split('?')[0]);
    if (pathname === '/') pathname = '/index.html';
    const file = normalize(join(root, pathname));
    if (!file.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();

const paths = [
  '/index.html', '/app.js', '/styles.css',
  '/src/supabaseClient.js', '/src/db.js', '/src/storage.js', '/src/rag.js',
  '/data/git-log.json', '/' + encodeURIComponent('RAG驗證結果報告.example.md'),
];

let hasConfig = true;
try { await access(join(root, 'config.js')); } catch { hasConfig = false; }
if (hasConfig) paths.push('/config.js');

let ok = 0;
for (const p of paths) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  if (res.ok) { ok++; console.log(`OK  ${res.status}  ${p}`); }
  else { console.error(`FAIL ${res.status} ${p}`); process.exitCode = 1; }
}

server.close();
console.log(`\n${ok}/${paths.length} static assets served`);
