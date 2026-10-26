import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const MAX = Number(process.env.GITLOG_MAX || 100);

function git(args) {
  return execSync(`git -c core.quotepath=false ${args}`, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 32,
  });
}

const STATUS_MAP = { A: 'added', M: 'modified', D: 'removed', R: 'renamed', C: 'copied', T: 'modified' };

let raw = '';
try {
  raw = git(`log -n ${MAX} --pretty=format:%H%x09%an%x09%aI%x09%s`);
} catch (e) {
  console.error('Not a git repository or git unavailable:', e.message);
  process.exit(1);
}

const commits = [];
for (const line of raw.split('\n')) {
  if (!line.trim()) continue;
  const [sha, author, date, ...subjectParts] = line.split('\t');
  const subject = subjectParts.join('\t');

  const files = [];
  try {
    const numstat = git(`show --numstat --format= ${sha}`);
    const nameStatus = git(`show --name-status --format= ${sha}`);
    const statusByPath = new Map();
    for (const l of nameStatus.split('\n')) {
      const m = l.match(/^([AMDRCT])\d*\t(.+)$/);
      if (m) statusByPath.set(m[2], m[1]);
    }
    for (const l of numstat.split('\n')) {
      const m = l.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      const path = m[3];
      const letter = statusByPath.get(path) || 'M';
      files.push({
        filename: path,
        status: STATUS_MAP[letter] || 'modified',
        additions: m[1] === '-' ? 0 : Number(m[1]),
        deletions: m[2] === '-' ? 0 : Number(m[2]),
      });
    }
  } catch (e) {
    console.warn(`skip commit ${sha.slice(0, 7)}: ${e.message}`);
  }

  commits.push({ sha, shortSha: sha.slice(0, 7), author, date, subject, files });
}

const outDir = resolve(root, 'data');
mkdirSync(outDir, { recursive: true });
const outFile = resolve(outDir, 'git-log.json');
writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), count: commits.length, commits }, null, 2), 'utf8');
console.log(`Wrote ${outFile} (${commits.length} commits)`);
