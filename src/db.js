// Data access layer. Works in two modes:
//   1. Cloud  - Supabase (RLS enforces owner-only access).
//   2. Local  - localStorage fallback for offline development / demo.
// The UI talks only to this layer, so switching modes requires no UI changes.

const LS = {
  projects: 'pct.projects',
  cases: 'pct.cases',
  tasks: 'pct.tasks',
  reports: 'pct.reports',
  attachments: 'pct.attachments',
};

const LOCAL_OWNER = 'local-user';

function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

function nowIso() {
  return new Date().toISOString();
}

function readLocal(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeLocal(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function byPosition(a, b) {
  const pa = Number(a.position ?? 0);
  const pb = Number(b.position ?? 0);
  if (pa !== pb) return pa - pb;
  return String(a.created_at || '').localeCompare(String(b.created_at || ''));
}

function nextPosition(items) {
  return items.reduce((max, it) => Math.max(max, Number(it.position ?? 0)), -1) + 1;
}

const PROJECT_FIELDS = ['key', 'name', 'description', 'status', 'color', 'position'];
const CASE_FIELDS = ['project_id', 'case_number', 'title', 'description', 'status', 'priority', 'due_date', 'position'];
const TASK_FIELDS = ['case_id', 'title', 'description', 'status', 'priority', 'due_date', 'position', 'is_done'];
const REPORT_FIELDS = ['project_id', 'case_id', 'title', 'kind', 'content_md'];
const ATTACHMENT_FIELDS = ['project_id', 'case_id', 'task_id', 'storage_path', 'file_name', 'mime_type', 'size_bytes'];

function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj[f] !== undefined) out[f] = obj[f];
  return out;
}

export function createDb(client) {
  const cloud = !!client;

  function assertCloud() {
    if (!cloud) throw new Error('此功能需要連線 Supabase 才能使用。');
  }

  // ---------- Projects ----------
  const projects = {
    async list() {
      if (cloud) {
        const { data, error } = await client.from('projects').select('*').order('position').order('created_at');
        if (error) throw error;
        return data || [];
      }
      return readLocal(LS.projects).sort(byPosition);
    },
    async get(id) {
      if (cloud) {
        const { data, error } = await client.from('projects').select('*').eq('id', id).maybeSingle();
        if (error) throw error;
        return data;
      }
      return readLocal(LS.projects).find((p) => p.id === id) || null;
    },
    async create(input) {
      const payload = pick(input, PROJECT_FIELDS);
      if (cloud) {
        const { data, error } = await client.from('projects').insert(payload).select().single();
        if (error) throw error;
        return data;
      }
      const all = readLocal(LS.projects);
      const row = {
        id: uid(), owner_id: LOCAL_OWNER,
        key: String(payload.key || '').trim(),
        name: String(payload.name || '').trim(),
        description: payload.description || '',
        status: payload.status || 'active',
        color: payload.color || '',
        position: payload.position ?? nextPosition(all),
        created_at: nowIso(), updated_at: nowIso(),
      };
      all.push(row); writeLocal(LS.projects, all);
      return row;
    },
    async update(id, input) {
      const payload = pick(input, PROJECT_FIELDS);
      if (cloud) {
        const { data, error } = await client.from('projects').update(payload).eq('id', id).select().single();
        if (error) throw error;
        return data;
      }
      const all = readLocal(LS.projects);
      const idx = all.findIndex((p) => p.id === id);
      if (idx === -1) throw new Error('找不到專案');
      all[idx] = { ...all[idx], ...payload, updated_at: nowIso() };
      writeLocal(LS.projects, all);
      return all[idx];
    },
    async remove(id) {
      if (cloud) {
        const { error } = await client.from('projects').delete().eq('id', id);
        if (error) throw error;
        return;
      }
      writeLocal(LS.projects, readLocal(LS.projects).filter((p) => p.id !== id));
      writeLocal(LS.cases, readLocal(LS.cases).filter((c) => c.project_id !== id));
      const remainingCaseIds = new Set(readLocal(LS.cases).map((c) => c.id));
      writeLocal(LS.tasks, readLocal(LS.tasks).filter((t) => remainingCaseIds.has(t.case_id)));
      writeLocal(LS.reports, readLocal(LS.reports).filter((r) => r.project_id !== id));
      writeLocal(LS.attachments, readLocal(LS.attachments).filter((a) => a.project_id !== id));
    },
  };

  // ---------- Cases ----------
  const cases = {
    async list(projectId) {
      if (cloud) {
        const { data, error } = await client.from('cases').select('*').eq('project_id', projectId).order('position').order('created_at');
        if (error) throw error;
        return data || [];
      }
      return readLocal(LS.cases).filter((c) => c.project_id === projectId).sort(byPosition);
    },
    async create(input) {
      const payload = pick(input, CASE_FIELDS);
      if (cloud) {
        const { data, error } = await client.from('cases').insert(payload).select().single();
        if (error) throw error;
        return data;
      }
      const all = readLocal(LS.cases);
      const row = {
        id: uid(), owner_id: LOCAL_OWNER,
        project_id: payload.project_id,
        case_number: payload.case_number || '',
        title: String(payload.title || '').trim(),
        description: payload.description || '',
        status: payload.status || 'todo',
        priority: payload.priority || 'medium',
        due_date: payload.due_date || null,
        position: payload.position ?? nextPosition(all.filter((c) => c.project_id === payload.project_id)),
        created_at: nowIso(), updated_at: nowIso(),
      };
      all.push(row); writeLocal(LS.cases, all);
      return row;
    },
    async update(id, input) {
      const payload = pick(input, CASE_FIELDS);
      if (cloud) {
        const { data, error } = await client.from('cases').update(payload).eq('id', id).select().single();
        if (error) throw error;
        return data;
      }
      const all = readLocal(LS.cases);
      const idx = all.findIndex((c) => c.id === id);
      if (idx === -1) throw new Error('找不到案件');
      all[idx] = { ...all[idx], ...payload, updated_at: nowIso() };
      writeLocal(LS.cases, all);
      return all[idx];
    },
    async remove(id) {
      if (cloud) {
        const { error } = await client.from('cases').delete().eq('id', id);
        if (error) throw error;
        return;
      }
      writeLocal(LS.cases, readLocal(LS.cases).filter((c) => c.id !== id));
      writeLocal(LS.tasks, readLocal(LS.tasks).filter((t) => t.case_id !== id));
      writeLocal(LS.reports, readLocal(LS.reports).filter((r) => r.case_id !== id));
      writeLocal(LS.attachments, readLocal(LS.attachments).filter((a) => a.case_id !== id));
    },
  };

  // ---------- Tasks (sub-tasks) ----------
  const tasks = {
    async list(caseId) {
      if (cloud) {
        const { data, error } = await client.from('tasks').select('*').eq('case_id', caseId).order('position').order('created_at');
        if (error) throw error;
        return data || [];
      }
      return readLocal(LS.tasks).filter((t) => t.case_id === caseId).sort(byPosition);
    },
    async create(input) {
      const payload = pick(input, TASK_FIELDS);
      if (cloud) {
        const { data, error } = await client.from('tasks').insert(payload).select().single();
        if (error) throw error;
        return data;
      }
      const all = readLocal(LS.tasks);
      const row = {
        id: uid(), owner_id: LOCAL_OWNER,
        case_id: payload.case_id,
        title: String(payload.title || '').trim(),
        description: payload.description || '',
        status: payload.status || 'todo',
        priority: payload.priority || 'medium',
        due_date: payload.due_date || null,
        position: payload.position ?? nextPosition(all.filter((t) => t.case_id === payload.case_id)),
        is_done: !!payload.is_done,
        created_at: nowIso(), updated_at: nowIso(),
      };
      all.push(row); writeLocal(LS.tasks, all);
      return row;
    },
    async update(id, input) {
      const payload = pick(input, TASK_FIELDS);
      if (cloud) {
        const { data, error } = await client.from('tasks').update(payload).eq('id', id).select().single();
        if (error) throw error;
        return data;
      }
      const all = readLocal(LS.tasks);
      const idx = all.findIndex((t) => t.id === id);
      if (idx === -1) throw new Error('找不到子任務');
      all[idx] = { ...all[idx], ...payload, updated_at: nowIso() };
      writeLocal(LS.tasks, all);
      return all[idx];
    },
    async remove(id) {
      if (cloud) {
        const { error } = await client.from('tasks').delete().eq('id', id);
        if (error) throw error;
        return;
      }
      writeLocal(LS.tasks, readLocal(LS.tasks).filter((t) => t.id !== id));
      writeLocal(LS.attachments, readLocal(LS.attachments).filter((a) => a.task_id !== id));
    },
    // Persist the visual order of a column after drag & drop.
    async reorder(orderedIds) {
      if (cloud) {
        await Promise.all(orderedIds.map((id, index) =>
          client.from('tasks').update({ position: index }).eq('id', id)
        ));
        return;
      }
      const all = readLocal(LS.tasks);
      const map = new Map(all.map((t) => [t.id, t]));
      orderedIds.forEach((id, index) => {
        const t = map.get(id);
        if (t) t.position = index;
      });
      writeLocal(LS.tasks, all);
    },
  };

  // ---------- Reports ----------
  const reports = {
    async list(projectId) {
      if (cloud) {
        let q = client.from('reports').select('*').order('created_at', { ascending: false });
        if (projectId) q = q.eq('project_id', projectId);
        const { data, error } = await q;
        if (error) throw error;
        return data || [];
      }
      const all = readLocal(LS.reports).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return projectId ? all.filter((r) => r.project_id === projectId) : all;
    },
    async create(input) {
      const payload = pick(input, REPORT_FIELDS);
      if (cloud) {
        const { data, error } = await client.from('reports').insert(payload).select().single();
        if (error) throw error;
        return data;
      }
      const all = readLocal(LS.reports);
      const row = {
        id: uid(), owner_id: LOCAL_OWNER,
        project_id: payload.project_id,
        case_id: payload.case_id || null,
        title: String(payload.title || '').trim(),
        kind: payload.kind || 'general',
        content_md: payload.content_md || '',
        created_at: nowIso(), updated_at: nowIso(),
      };
      all.push(row); writeLocal(LS.reports, all);
      return row;
    },
    async remove(id) {
      if (cloud) {
        const { error } = await client.from('reports').delete().eq('id', id);
        if (error) throw error;
        return;
      }
      writeLocal(LS.reports, readLocal(LS.reports).filter((r) => r.id !== id));
    },
  };

  // ---------- Attachments (metadata only; files live in Storage) ----------
  const attachments = {
    async list({ caseId, taskId }) {
      if (cloud) {
        let q = client.from('attachments').select('*').order('created_at');
        if (caseId) q = q.eq('case_id', caseId);
        if (taskId) q = q.eq('task_id', taskId);
        const { data, error } = await q;
        if (error) throw error;
        return data || [];
      }
      const all = readLocal(LS.attachments);
      return all.filter((a) => (caseId ? a.case_id === caseId : true) && (taskId ? a.task_id === taskId : true));
    },
    async create(input) {
      const payload = pick(input, ATTACHMENT_FIELDS);
      if (cloud) {
        const { data, error } = await client.from('attachments').insert(payload).select().single();
        if (error) throw error;
        return data;
      }
      const all = readLocal(LS.attachments);
      const row = { id: uid(), owner_id: LOCAL_OWNER, created_at: nowIso(), ...payload };
      all.push(row); writeLocal(LS.attachments, all);
      return row;
    },
    async remove(id) {
      if (cloud) {
        const { error } = await client.from('attachments').delete().eq('id', id);
        if (error) throw error;
        return;
      }
      writeLocal(LS.attachments, readLocal(LS.attachments).filter((a) => a.id !== id));
    },
  };

  return { isCloud: cloud, projects, cases, tasks, reports, attachments };
}

// Seed a small, clearly-labelled demo dataset for local mode so the UI is usable
// before Supabase is configured. Safe to delete from Settings.
export function seedDemoIfEmpty() {
  const existing = readLocal(LS.projects);
  if (existing.length > 0) return false;

  const project = {
    id: uid(), owner_id: LOCAL_OWNER, key: 'demo',
    name: '示範專案（可刪除）', description: '本機示範資料，設定頁可一鍵清除。',
    status: 'active', color: '#2563eb', position: 0,
    created_at: nowIso(), updated_at: nowIso(),
  };
  const caseRow = {
    id: uid(), owner_id: LOCAL_OWNER, project_id: project.id,
    case_number: 'DEMO-001', title: '示範案件：建立第一個追蹤項目',
    description: '這是示範案件，點進來新增子任務。',
    status: 'in_progress', priority: 'medium', due_date: null, position: 0,
    created_at: nowIso(), updated_at: nowIso(),
  };
  const tasks = [
    ['todo', '整理需求', 0], ['in_progress', '建立子任務', 1], ['done', '完成初始設定', 2],
  ].map(([status, title, position]) => ({
    id: uid(), owner_id: LOCAL_OWNER, case_id: caseRow.id,
    title, description: '', status, priority: 'medium', due_date: null,
    position, is_done: status === 'done', created_at: nowIso(), updated_at: nowIso(),
  }));

  writeLocal(LS.projects, [project]);
  writeLocal(LS.cases, [caseRow]);
  writeLocal(LS.tasks, tasks);
  writeLocal(LS.reports, []);
  writeLocal(LS.attachments, []);
  return true;
}

export function clearLocalData() {
  Object.values(LS).forEach((k) => localStorage.removeItem(k));
}

export function exportLocalData() {
  return {
    projects: readLocal(LS.projects),
    cases: readLocal(LS.cases),
    tasks: readLocal(LS.tasks),
    reports: readLocal(LS.reports),
    attachments: readLocal(LS.attachments),
  };
}

export function importLocalData(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('格式錯誤');
  for (const [name, key] of Object.entries(LS)) {
    if (Array.isArray(payload[name])) writeLocal(key, payload[name]);
  }
}
