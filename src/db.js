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

  const now = nowIso();
  const makeProject = (key, name, description, color, position) => ({
    id: uid(), owner_id: LOCAL_OWNER, key, name, description,
    status: 'active', color, position, created_at: now, updated_at: now,
  });
  const makeCase = (projectId, caseNumber, title, description, status, priority, position) => ({
    id: uid(), owner_id: LOCAL_OWNER, project_id: projectId,
    case_number: caseNumber, title, description, status, priority,
    due_date: null, position, created_at: now, updated_at: now,
  });
  const makeTask = (caseId, title, status, priority, position, description = '') => ({
    id: uid(), owner_id: LOCAL_OWNER, case_id: caseId,
    title, description, status, priority, due_date: null,
    position, is_done: status === 'done', created_at: now, updated_at: now,
  });

  const wm = makeProject(
    'wm',
    'WM 流程自動化',
    'Notes / Open WebUI → FlowAgent → flow_funcs → flow_result',
    '#0ea5e9',
    0,
  );
  const tracker = makeProject(
    'tracker',
    '個人專案追蹤平台',
    '本平台建置進度（GitHub Pages + Supabase）',
    '#7c3aed',
    1,
  );

  const wmCases = [
    ['WM-001', 'Notes 客戶端觸發', '從 Notes 按鈕送出案件欄位到 FlowAgent。', 'done', 'high', [
      ['done', '確認按鈕與欄位', 'high'],
      ['done', '整理送出格式', 'medium'],
    ]],
    ['WM-002', 'Open WebUI 觸發', '從 Open WebUI 發起同一條流程，驗證多入口。', 'in_progress', 'high', [
      ['done', '建立 API 呼叫範例', 'high'],
      ['in_progress', '帶入知識庫 ID 與提示詞', 'high'],
      ['todo', '處理回傳格式', 'medium'],
    ]],
    ['WM-003', 'FlowAgent 跳板', '接收請求、檢查 trigger、分派 flow_funcs。', 'in_progress', 'urgent', [
      ['done', '確認 trigger 條件', 'urgent'],
      ['in_progress', '錯誤處理與重試', 'high'],
      ['todo', '執行日誌欄位', 'medium'],
    ]],
    ['WM-004', 'flow_funcs 逐項執行', 'FlowRun / Trigger / FlowFinish 依序執行，例外可回復。', 'todo', 'high', [
      ['todo', '定義執行順序', 'high'],
      ['todo', '例外回復機制', 'high'],
    ]],
    ['WM-005', 'flow_result 寫回', '將結果、狀態碼與訊息寫回文件。', 'todo', 'high', [
      ['todo', '確認寫回欄位', 'high'],
      ['todo', '成功／失敗通知', 'medium'],
    ]],
    ['WM-006', 'UI / GA 顯示', '前端顯示執行進度，GA 事件回傳。', 'todo', 'medium', [
      ['todo', '進度條與狀態', 'medium'],
      ['todo', 'GA 事件埋點', 'low'],
    ]],
  ];

  const trackerCases = [
    ['Phase 0', '安全修正', '移除硬編碼 token、建立 config 範本、修正 RAG 檔名。', 'done', 'high', [
      ['done', '移除硬編碼 GitHub Token', 'high'],
      ['done', '建立 config.example.js / .env.example', 'high'],
      ['done', '修正 RAG 報告檔名', 'medium'],
    ]],
    ['Phase 1', '資料庫設計與 SQL', '建立 schema、RLS、Storage bucket 與測試資料。', 'in_progress', 'urgent', [
      ['done', '撰寫 supabase/migrations/0001_init.sql', 'high'],
      ['todo', '在 Supabase SQL Editor 執行 migration', 'urgent'],
      ['todo', '建立第一個登入帳號', 'urgent'],
      ['todo', '驗證 RLS 與 Storage 政策', 'high'],
    ]],
    ['Phase 2', '前端整合 Supabase', '登入、三層 CRUD、看板與雲端驗證。', 'in_progress', 'high', [
      ['done', '登入與三層 CRUD', 'high'],
      ['done', '看板拖曳與排序', 'medium'],
      ['todo', '登入後進行雲端寫入驗證', 'high'],
    ]],
    ['Phase 3', '附件上傳', '私有 Storage 桶、簽名網址與附件關聯。', 'done', 'medium', [
      ['done', '上傳／列表／刪除', 'high'],
      ['done', '簽名網址預覽', 'medium'],
    ]],
    ['Phase 4', '部署與設定', 'GitHub 版控、GitHub Pages 自動部署。', 'done', 'high', [
      ['done', '建立乾淨 Git 歷史並推送', 'high'],
      ['done', 'GitHub Pages workflow 部署成功', 'high'],
      ['todo', '（選用）自訂網域', 'low'],
    ]],
    ['Phase 5', '未來擴充', 'DCTGit 同步、AI 摘要、n8n / OpenWebUI 整合。', 'todo', 'low', [
      ['todo', 'DCTGit 同步（需公司允許）', 'low'],
      ['todo', 'AI 自動摘要與進度分析', 'low'],
    ]],
  ];

  const projects = [wm, tracker];
  const cases = [];
  const tasks = [];

  const addCases = (project, specs) => {
    let casePos = 0;
    for (const [number, title, description, status, priority, taskSpec] of specs) {
      const caseRow = makeCase(project.id, number, title, description, status, priority, casePos++);
      cases.push(caseRow);
      taskSpec.forEach(([taskStatus, taskTitle, taskPriority], index) => {
        tasks.push(makeTask(caseRow.id, taskTitle, taskStatus, taskPriority, index));
      });
    }
  };

  addCases(wm, wmCases);
  addCases(tracker, trackerCases);

  writeLocal(LS.projects, projects);
  writeLocal(LS.cases, cases);
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
