import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// --- localStorage polyfill -------------------------------------------------
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
  key: (i) => Array.from(mem.keys())[i] ?? null,
  get length() { return mem.size; },
};

const { createDb, seedDemoIfEmpty, clearLocalData } = await import('../src/db.js');
const { parseRagMarkdown } = await import('../src/rag.js');

const db = createDb(null);
assert.equal(db.isCloud, false, 'local db should not be cloud');

let passed = 0;
function ok(cond, label) { assert.ok(cond, label); passed++; console.log('  ✓', label); }

// --- Projects --------------------------------------------------------------
const project = await db.projects.create({ key: 'test', name: '測試專案', description: 'd', status: 'active' });
ok(project.id && project.owner_id === 'local-user', 'create project');
ok((await db.projects.list()).length === 1, 'list projects');
await db.projects.update(project.id, { name: '測試專案2' });
ok((await db.projects.get(project.id)).name === '測試專案2', 'update project');

// --- Cases -----------------------------------------------------------------
const c1 = await db.cases.create({ project_id: project.id, title: '案件A', status: 'todo', priority: 'high' });
ok((await db.cases.list(project.id)).length === 1, 'create/list case');
await db.cases.update(c1.id, { status: 'in_progress' });
ok((await db.cases.list(project.id))[0].status === 'in_progress', 'update case');

// --- Tasks -----------------------------------------------------------------
const t1 = await db.tasks.create({ case_id: c1.id, title: 'T1', status: 'todo' });
const t2 = await db.tasks.create({ case_id: c1.id, title: 'T2', status: 'todo' });
ok((await db.tasks.list(c1.id)).length === 2, 'create/list tasks');
await db.tasks.update(t1.id, { status: 'done', is_done: true });
await db.tasks.reorder([t2.id, t1.id]);
const ordered = await db.tasks.list(c1.id);
ok(ordered[0].id === t2.id && ordered[1].id === t1.id, 'reorder tasks persists');

// --- Reports ---------------------------------------------------------------
const rep = await db.reports.create({ project_id: project.id, title: 'R1', kind: 'note', content_md: '# hi' });
ok((await db.reports.list(project.id)).length === 1, 'create/list report');
await db.reports.remove(rep.id);
ok((await db.reports.list(project.id)).length === 0, 'remove report');

// --- Cascade delete --------------------------------------------------------
await db.cases.remove(c1.id);
ok((await db.tasks.list(c1.id)).length === 0, 'delete case cascades tasks');
await db.projects.remove(project.id);
ok((await db.projects.list()).length === 0, 'delete project');

// --- Seed / clear ----------------------------------------------------------
clearLocalData();
ok(seedDemoIfEmpty() === true, 'seed demo when empty');
const seededProjects = await db.projects.list();
ok(seededProjects.length === 2, 'seed creates two projects');
const wmProject = seededProjects.find((p) => p.key === 'wm');
ok(!!wmProject, 'seed creates WM project');
const wmCases = wmProject ? await db.cases.list(wmProject.id) : [];
ok(wmCases.length >= 6, `seed creates WM cases (got ${wmCases.length})`);
const firstWmCase = wmCases[0];
const wmTasks = firstWmCase ? await db.tasks.list(firstWmCase.id) : [];
ok(wmTasks.length >= 2, 'seed creates WM tasks');
ok(seedDemoIfEmpty() === false, 'seed is idempotent');
clearLocalData();
ok((await db.projects.list()).length === 0, 'clear local data');

// --- RAG markdown parsing (real report) ------------------------------------
const ragFile = readdirSync(root).find((n) => n.endsWith('.example.md'))
  || readdirSync(root).find((n) => n.startsWith('RAG') && n.endsWith('.md'));
ok(!!ragFile, 'found RAG markdown report');
const parsed = parseRagMarkdown(readFileSync(resolve(root, ragFile), 'utf8'));
ok(parsed.results.length >= 5, `parse RAG rows (got ${parsed.results.length})`);
ok(parsed.max > 0.9 && parsed.max <= 1, `max score ${parsed.max}`);
ok(parsed.results.every((r) => typeof r.score === 'number' && r.caseId), 'RAG rows have score + caseId');

console.log(`\nAll ${passed} local checks passed.`);
