import { createSupabaseClient } from './src/supabaseClient.js';
import { createDb, seedDemoIfEmpty, clearLocalData, exportLocalData, importLocalData } from './src/db.js';
import { uploadAttachment, getSignedUrl, removeObject, formatBytes } from './src/storage.js';
import { parseRagMarkdown } from './src/rag.js';

// ---------------------------------------------------------------------------
// Config loading. `config.js` is git-ignored and generated at build time.
// If it is absent we fall back to local demo mode (no cloud calls).
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  SUPABASE_URL: '',
  SUPABASE_PUBLISHABLE_KEY: '',
  GIT_LOG_URL: 'data/git-log.json',
  RAG_REPORT_URL: 'RAG驗證結果報告.md',
};

let CONFIG = { ...DEFAULT_CONFIG };
try {
  const mod = await import('./config.js');
  CONFIG = { ...DEFAULT_CONFIG, ...mod };
} catch {
  console.info('[config] config.js not found - running in local demo mode.');
}

const client = createSupabaseClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_PUBLISHABLE_KEY);
const cloudDb = client ? createDb(client) : null;
const localDb = createDb(null);
let db = cloudDb || localDb;
let usingLocal = !cloudDb;

const state = {
  session: null,
  projectId: null,
  caseId: null,
  projects: [],
  cases: [],
  tasks: [],
  reports: [],
  fileHistory: [],
  ragData: null,
};

let attachmentRefresh = null;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const STATUS_LABELS = {
  todo: '待辦', in_progress: '進行中', review: '待審', done: '完成',
  active: '啟用', paused: '暫停', archived: '封存',
};
const PRIORITY_LABELS = { low: '低', medium: '中', high: '高', urgent: '緊急' };

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', init);

async function init() {
  bindStatic();
  setupTabs();

  if (client) {
    const { data } = await client.auth.getSession();
    state.session = data.session || null;
    client.auth.onAuthStateChange(async (_event, session) => {
      state.session = session;
      await handleAuthState();
    });
  }

  updateConnBadge();
  await handleAuthState();
  await Promise.all([loadGitLog(), loadRagReport()]);
}

async function handleAuthState() {
  const overlay = $('#authOverlay');
  const userArea = $('#userArea');

  // Decide which data backend to use for this render.
  if (state.session) {
    usingLocal = false;
    db = cloudDb || localDb;
  } else if (!client) {
    usingLocal = true;
    db = localDb;
  }

  // Cloud configured, not logged in, and user has not chosen local demo -> login gate.
  if (client && !state.session && !usingLocal) {
    overlay.classList.remove('hidden');
    userArea.innerHTML = '';
    state.projects = []; state.cases = []; state.tasks = []; state.reports = [];
    state.projectId = null; state.caseId = null;
    renderAll();
    updateConnBadge();
    return;
  }

  overlay.classList.add('hidden');

  if (state.session) {
    const email = state.session.user?.email || '';
    userArea.innerHTML = `<span>${escapeHtml(email)}</span>`;
    const logout = document.createElement('button');
    logout.className = 'btn btn-ghost btn-sm';
    logout.textContent = '登出';
    logout.addEventListener('click', () => client.auth.signOut());
    userArea.appendChild(logout);
  } else {
    seedDemoIfEmpty();
    userArea.innerHTML = '<span>本機模式</span>';
    if (client) {
      const toCloud = document.createElement('button');
      toCloud.className = 'btn btn-ghost btn-sm';
      toCloud.textContent = '雲端登入';
      toCloud.addEventListener('click', () => { usingLocal = false; handleAuthState(); });
      userArea.appendChild(toCloud);
    }
  }

  updateConnBadge();
  await refreshAll();
}

function updateConnBadge() {
  const badge = $('#connBadge');
  if (!client) {
    badge.textContent = '本機示範模式';
    badge.className = 'conn-badge local';
  } else if (state.session) {
    badge.textContent = 'Supabase 已登入';
    badge.className = 'conn-badge cloud';
  } else if (usingLocal) {
    badge.textContent = '本機示範模式';
    badge.className = 'conn-badge local';
  } else {
    badge.textContent = 'Supabase 未登入';
    badge.className = 'conn-badge';
  }
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------
function setupTabs() {
  $$('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  });
}

function activateTab(name) {
  $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-content').forEach((c) => c.classList.toggle('active', c.id === `${name}-tab`));
}

function bindStatic() {
  $('#refreshBtn').addEventListener('click', refreshAll);
  $('#newProjectBtn').addEventListener('click', () => openProjectForm());
  $('#newCaseBtn').addEventListener('click', () => openCaseForm());
  $('#newTaskBtn').addEventListener('click', () => openTaskForm());
  $('#newReportBtn').addEventListener('click', () => openReportForm());
  $('#caseAttachmentsBtn').addEventListener('click', openAttachmentsModal);
  $('#backToProjectsBtn').addEventListener('click', () => { state.projectId = null; state.caseId = null; refreshAll(); activateTab('projects'); });
  $('#backToCasesBtn').addEventListener('click', () => { state.caseId = null; refreshAll(); activateTab('cases'); });

  $('#fileSearch').addEventListener('input', debounce(renderFileList, 250));
  $('#fileTypeFilter').addEventListener('change', renderFileList);

  $('#seedDemoBtn').addEventListener('click', onSeedDemo);
  $('#clearDataBtn').addEventListener('click', onClearData);
  $('#exportDataBtn').addEventListener('click', onExportData);
  $('#importFile').addEventListener('change', onImportData);
  $('#reloadGitLogBtn').addEventListener('click', () => { loadGitLog(); loadRagReport(); });

  $('#loginForm').addEventListener('submit', onLogin);
  $('#localModeBtn').addEventListener('click', () => { usingLocal = true; handleAuthState(); });

  $$('.add-task-btn').forEach((btn) => {
    btn.addEventListener('click', () => openTaskForm(null, btn.dataset.status));
  });

  document.addEventListener('click', onDocumentClick);
  setupDragAndDrop();
}

function onDocumentClick(e) {
  const actionEl = e.target.closest('[data-action]');
  if (actionEl) {
    e.stopPropagation();
    handleAction(actionEl.dataset.action, actionEl);
    return;
  }
  const projectCard = e.target.closest('[data-project-id]');
  if (projectCard) { openProject(projectCard.dataset.projectId); return; }
  const caseCard = e.target.closest('[data-case-id]');
  if (caseCard) { openCase(caseCard.dataset.caseId); return; }
}

async function handleAction(action, el) {
  const id = el.dataset.id;
  try {
    switch (action) {
      case 'close-modal': closeModal(); break;
      case 'edit-project': openProjectForm(id); break;
      case 'del-project': if (confirm('刪除此專案及其所有案件、子任務？')) { await db.projects.remove(id); await afterDeleteProject(id); } break;
      case 'edit-case': openCaseForm(id); break;
      case 'del-case': if (confirm('刪除此案件及其子任務？')) { await db.cases.remove(id); await refreshAll(); } break;
      case 'edit-task': openTaskForm(id); break;
      case 'del-task': if (confirm('刪除此子任務？')) { await db.tasks.remove(id); await refreshAll(); } break;
      case 'del-report': if (confirm('刪除此報告？')) { await db.reports.remove(id); await refreshAll(); } break;
      case 'download-attachment': {
        const url = await getSignedUrl(client, el.dataset.path);
        window.open(url, '_blank', 'noopener');
        break;
      }
      case 'del-attachment': {
        if (!confirm('刪除此附件？')) break;
        await db.attachments.remove(id);
        if (el.dataset.path) await removeObject(client, el.dataset.path);
        if (attachmentRefresh) await attachmentRefresh();
        toast('附件已刪除', 'success');
        break;
      }
    }
  } catch (err) {
    toast(`操作失敗：${err.message}`, 'error');
  }
}

async function afterDeleteProject(id) {
  if (state.projectId === id) { state.projectId = null; state.caseId = null; }
  await refreshAll();
}

// ---------------------------------------------------------------------------
// Data loading / rendering
// ---------------------------------------------------------------------------
async function refreshAll() {
  if (client && !state.session && !usingLocal) return;
  try {
    state.projects = await db.projects.list();

    if (state.projectId && !state.projects.some((p) => p.id === state.projectId)) {
      state.projectId = null; state.caseId = null;
    }
    if (state.projectId) {
      state.cases = await db.cases.list(state.projectId);
      if (state.caseId && !state.cases.some((c) => c.id === state.caseId)) state.caseId = null;
    } else {
      state.cases = []; state.caseId = null;
    }
    state.tasks = state.caseId ? await db.tasks.list(state.caseId) : [];
    state.reports = await db.reports.list(state.projectId || null);
  } catch (err) {
    toast(`載入失敗：${err.message}`, 'error');
  }
  renderAll();
}

function renderAll() {
  renderBreadcrumb();
  renderProjects();
  renderCases();
  renderTasks();
  renderReports();
  renderSettings();
  updateToolbarState();
}

function currentProject() { return state.projects.find((p) => p.id === state.projectId) || null; }
function currentCase() { return state.cases.find((c) => c.id === state.caseId) || null; }

function updateToolbarState() {
  $('#newCaseBtn').disabled = !state.projectId;
  $('#newTaskBtn').disabled = !state.caseId;
  $('#caseAttachmentsBtn').disabled = !state.caseId;
  $('#newReportBtn').disabled = !state.projectId;
}

function renderBreadcrumb() {
  const crumb = $('#breadcrumb');
  const parts = [];
  const p = currentProject();
  const c = currentCase();
  if (p) parts.push(`<span class="crumb">${escapeHtml(p.name)}</span>`);
  if (c) parts.push(`<span class="crumb">${escapeHtml(c.title)}</span>`);
  crumb.innerHTML = parts.join('<span class="sep">›</span>');
}

function renderProjects() {
  const grid = $('#projectGrid');
  if (!state.projects.length) {
    grid.innerHTML = '<p class="empty-state">尚無專案，點右上角「+ 新增專案」開始。</p>';
    return;
  }
  grid.innerHTML = state.projects.map((p) => `
    <article class="card" data-project-id="${escapeAttr(p.id)}" style="border-top-color:${normalizeColor(p.color) || 'var(--primary)'}">
      <div class="card-head">
        <div>
          <div class="card-title">${escapeHtml(p.name)}</div>
          <span class="card-key">${escapeHtml(p.key || '')}</span>
        </div>
        <span class="pill ${escapeAttr(p.status || 'active')}">${statusLabel(p.status)}</span>
      </div>
      <div class="card-desc">${escapeHtml(p.description || '（無描述）')}</div>
      <div class="card-foot">
        <span>建立 ${formatDate(p.created_at)}</span>
        <div class="card-actions">
          <button class="btn btn-ghost btn-sm" data-action="edit-project" data-id="${escapeAttr(p.id)}">編輯</button>
          <button class="btn btn-danger btn-sm" data-action="del-project" data-id="${escapeAttr(p.id)}">刪除</button>
        </div>
      </div>
    </article>`).join('');
}

function renderCases() {
  const list = $('#caseList');
  const p = currentProject();
  $('#casesTitle').textContent = p ? `案件：${p.name}` : '案件';
  if (!p) {
    list.innerHTML = '<p class="empty-state">請先在「專案」分頁選擇或新增一個專案。</p>';
    return;
  }
  if (!state.cases.length) {
    list.innerHTML = '<p class="empty-state">此專案尚無案件，點右上角「+ 新增案件」。</p>';
    return;
  }
  list.innerHTML = state.cases.map((c) => `
    <div class="case-card" data-case-id="${escapeAttr(c.id)}">
      <div class="case-main">
        <div class="case-title">${escapeHtml(c.title)} ${c.case_number ? `<span class="case-number">${escapeHtml(c.case_number)}</span>` : ''}</div>
        <div class="case-meta">
          <span class="pill ${escapeAttr(c.status || 'todo')}">${statusLabel(c.status)}</span>
          <span class="pill ${escapeAttr(c.priority || 'medium')}">${priorityLabel(c.priority)}</span>
          ${c.due_date ? `<span>期限 ${escapeHtml(c.due_date)}</span>` : ''}
          ${c.description ? `<span>${escapeHtml(truncate(c.description, 40))}</span>` : ''}
        </div>
      </div>
      <div class="case-actions">
        <button class="btn btn-ghost btn-sm" data-action="edit-case" data-id="${escapeAttr(c.id)}">編輯</button>
        <button class="btn btn-danger btn-sm" data-action="del-case" data-id="${escapeAttr(c.id)}">刪除</button>
      </div>
    </div>`).join('');
}

function renderTasks() {
  const c = currentCase();
  $('#tasksTitle').textContent = c ? `子任務：${c.title}` : '子任務';
  const columns = ['todo', 'in_progress', 'review', 'done'];
  columns.forEach((status) => {
    const listEl = $(`.task-list[data-status="${status}"]`);
    const tasks = state.tasks.filter((t) => (t.status || 'todo') === status);
    listEl.innerHTML = tasks.map((t) => `
      <div class="task-card priority-${escapeAttr(t.priority || 'medium')}" draggable="true" data-task-id="${escapeAttr(t.id)}">
        <div class="task-header">
          <span class="task-title">${escapeHtml(t.title)}</span>
          <span class="pill ${escapeAttr(t.priority || 'medium')}">${priorityLabel(t.priority)}</span>
        </div>
        ${t.description ? `<div class="task-desc">${escapeHtml(t.description)}</div>` : ''}
        <div class="task-meta">${t.due_date ? `<span>期限 ${escapeHtml(t.due_date)}</span>` : ''}${t.is_done ? '<span>✔ 完成</span>' : ''}</div>
        <div class="task-actions">
          <button class="btn btn-ghost btn-sm" data-action="edit-task" data-id="${escapeAttr(t.id)}">編輯</button>
          <button class="btn btn-danger btn-sm" data-action="del-task" data-id="${escapeAttr(t.id)}">刪除</button>
        </div>
      </div>`).join('');
    const countEl = $(`.kanban-column[data-status="${status}"] .count`);
    if (countEl) countEl.textContent = tasks.length;
  });
}

function renderReports() {
  const list = $('#reportsList');
  if (!state.reports.length) {
    list.innerHTML = '<p class="empty-state">尚無報告。</p>';
    return;
  }
  list.innerHTML = state.reports.map((r) => `
    <div class="report-card">
      <div class="card-foot" style="margin-bottom:.25rem">
        <h3>${escapeHtml(r.title)} <span class="pill">${escapeHtml(r.kind || 'general')}</span></h3>
        <div style="display:flex;gap:.4rem;align-items:center">
          <span class="hint">${formatDate(r.created_at)}</span>
          <button class="btn btn-danger btn-sm" data-action="del-report" data-id="${escapeAttr(r.id)}">刪除</button>
        </div>
      </div>
      ${r.content_md ? `<pre>${escapeHtml(r.content_md)}</pre>` : ''}
    </div>`).join('');
}

function renderSettings() {
  $('#settingsMode').textContent = state.session
    ? 'Supabase 雲端模式'
    : (usingLocal ? '本機示範模式（localStorage）' : 'Supabase 未登入');
  $('#settingsUrl').textContent = CONFIG.SUPABASE_URL || '（未設定）';
  $('#settingsUser').textContent = state.session?.user?.email || '（未登入）';
}

// ---------------------------------------------------------------------------
// Forms / modals
// ---------------------------------------------------------------------------
function openModal({ title, body, submitLabel = '儲存', onSubmit }) {
  const root = $('#modalRoot');
  root.innerHTML = `
    <div class="modal" id="modal">
      <div class="modal-content">
        <h3>${escapeHtml(title)}</h3>
        <form id="modalForm">
          ${body}
          <div class="modal-actions">
            <button type="button" class="btn btn-secondary" data-action="close-modal">取消</button>
            <button type="submit" class="btn btn-primary">${escapeHtml(submitLabel)}</button>
          </div>
        </form>
      </div>
    </div>`;
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  $('#modalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    if (btn) btn.disabled = true;
    try {
      await onSubmit(new FormData(e.target));
      closeModal();
    } catch (err) {
      toast(`儲存失敗：${err.message}`, 'error');
      if (btn) btn.disabled = false;
    }
  });
}

function closeModal() {
  $('#modalRoot').innerHTML = '';
  attachmentRefresh = null;
}

function openProjectForm(id) {
  const p = id ? state.projects.find((x) => x.id === id) : null;
  openModal({
    title: p ? '編輯專案' : '新增專案',
    body: `
      <div class="form-group"><label>專案代碼 (key)</label><input class="form-input" name="key" required value="${escapeAttr(p?.key || '')}" placeholder="例如 wm、ai-tracker"></div>
      <div class="form-group"><label>名稱</label><input class="form-input" name="name" required value="${escapeAttr(p?.name || '')}"></div>
      <div class="form-group"><label>描述</label><textarea class="form-input" name="description" rows="3">${escapeHtml(p?.description || '')}</textarea></div>
      <div class="form-row">
        <div class="form-group"><label>狀態</label>
          <select class="form-input" name="status">${selectOptions(['active', 'paused', 'archived'], p?.status || 'active', STATUS_LABELS)}</select>
        </div>
        <div class="form-group"><label>顏色</label><input class="form-input" type="color" name="color" value="${normalizeColor(p?.color) || '#2563eb'}"></div>
      </div>`,
    onSubmit: async (fd) => {
      const data = Object.fromEntries(fd.entries());
      if (p) await db.projects.update(p.id, data);
      else await db.projects.create(data);
      await refreshAll();
      toast(p ? '專案已更新' : '專案已新增', 'success');
    },
  });
}

function openCaseForm(id) {
  if (!state.projectId) return toast('請先選擇專案', 'error');
  const c = id ? state.cases.find((x) => x.id === id) : null;
  openModal({
    title: c ? '編輯案件' : '新增案件',
    body: `
      <div class="form-row">
        <div class="form-group"><label>案件編號</label><input class="form-input" name="case_number" value="${escapeAttr(c?.case_number || '')}" placeholder="例如 WM-10404-0195"></div>
        <div class="form-group"><label>期限</label><input class="form-input" type="date" name="due_date" value="${escapeAttr(c?.due_date || '')}"></div>
      </div>
      <div class="form-group"><label>標題</label><input class="form-input" name="title" required value="${escapeAttr(c?.title || '')}"></div>
      <div class="form-group"><label>描述</label><textarea class="form-input" name="description" rows="3">${escapeHtml(c?.description || '')}</textarea></div>
      <div class="form-row">
        <div class="form-group"><label>狀態</label>
          <select class="form-input" name="status">${selectOptions(['todo', 'in_progress', 'review', 'done', 'archived'], c?.status || 'todo', STATUS_LABELS)}</select>
        </div>
        <div class="form-group"><label>優先級</label>
          <select class="form-input" name="priority">${selectOptions(['low', 'medium', 'high', 'urgent'], c?.priority || 'medium', PRIORITY_LABELS)}</select>
        </div>
      </div>`,
    onSubmit: async (fd) => {
      const data = Object.fromEntries(fd.entries());
      data.project_id = state.projectId;
      data.due_date = data.due_date || null;
      if (c) await db.cases.update(c.id, data);
      else await db.cases.create(data);
      await refreshAll();
      toast(c ? '案件已更新' : '案件已新增', 'success');
    },
  });
}

function openTaskForm(id, defaultStatus = 'todo') {
  if (!state.caseId) return toast('請先選擇案件', 'error');
  const t = id ? state.tasks.find((x) => x.id === id) : null;
  openModal({
    title: t ? '編輯子任務' : '新增子任務',
    body: `
      <div class="form-group"><label>標題</label><input class="form-input" name="title" required value="${escapeAttr(t?.title || '')}"></div>
      <div class="form-group"><label>描述</label><textarea class="form-input" name="description" rows="3">${escapeHtml(t?.description || '')}</textarea></div>
      <div class="form-row">
        <div class="form-group"><label>狀態</label>
          <select class="form-input" name="status">${selectOptions(['todo', 'in_progress', 'review', 'done'], t?.status || defaultStatus, STATUS_LABELS)}</select>
        </div>
        <div class="form-group"><label>優先級</label>
          <select class="form-input" name="priority">${selectOptions(['low', 'medium', 'high', 'urgent'], t?.priority || 'medium', PRIORITY_LABELS)}</select>
        </div>
      </div>
      <div class="form-group"><label>期限</label><input class="form-input" type="date" name="due_date" value="${escapeAttr(t?.due_date || '')}"></div>`,
    onSubmit: async (fd) => {
      const data = Object.fromEntries(fd.entries());
      data.case_id = state.caseId;
      data.due_date = data.due_date || null;
      data.is_done = data.status === 'done';
      if (t) await db.tasks.update(t.id, data);
      else await db.tasks.create(data);
      await refreshAll();
      toast(t ? '子任務已更新' : '子任務已新增', 'success');
    },
  });
}

function openReportForm() {
  if (!state.projectId) return toast('請先選擇專案', 'error');
  openModal({
    title: '新增報告',
    body: `
      <div class="form-group"><label>標題</label><input class="form-input" name="title" required></div>
      <div class="form-group"><label>類型</label><input class="form-input" name="kind" value="general" placeholder="general / rag_eval / note"></div>
      <div class="form-group"><label>內容 (Markdown)</label><textarea class="form-input" name="content_md" rows="6"></textarea></div>`,
    onSubmit: async (fd) => {
      const data = Object.fromEntries(fd.entries());
      data.project_id = state.projectId;
      data.case_id = state.caseId || null;
      await db.reports.create(data);
      await refreshAll();
      toast('報告已新增', 'success');
    },
  });
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------
async function openAttachmentsModal() {
  if (!state.caseId) return toast('請先選擇案件', 'error');
  if (!client || !state.session) return toast('附件功能需要登入 Supabase 雲端模式', 'error');
  const c = currentCase();
  const p = currentProject();

  const root = $('#modalRoot');
  root.innerHTML = `
    <div class="modal" id="modal">
      <div class="modal-content">
        <h3>附件：${escapeHtml(c?.title || '')}</h3>
        <div id="attachmentList" class="attachment-list">載入中…</div>
        <label class="btn btn-secondary file-label">上傳檔案
          <input type="file" id="attachInput" hidden>
        </label>
        <p class="hint">檔案儲存於私有 Storage 桶，僅本人可透過簽名網址存取。公司機密請勿上傳。</p>
        <div class="modal-actions"><button class="btn btn-secondary" data-action="close-modal">關閉</button></div>
      </div>
    </div>`;
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

  attachmentRefresh = renderAttachmentList;
  await renderAttachmentList();

  $('#attachInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    try {
      toast('上傳中…', 'info');
      const meta = await uploadAttachment(client, file, {
        userId: state.session.user.id,
        projectId: p?.id,
        caseId: c?.id,
      });
      await db.attachments.create({
        case_id: c?.id,
        ...meta,
      });
      toast('附件已上傳', 'success');
      await renderAttachmentList();
    } catch (err) {
      toast(`上傳失敗：${err.message}`, 'error');
    }
  });
}

async function renderAttachmentList() {
  const box = $('#attachmentList');
  if (!box) return;
  try {
    const items = await db.attachments.list({ caseId: state.caseId });
    if (!items.length) {
      box.innerHTML = '<p class="hint">尚無附件。</p>';
      return;
    }
    box.innerHTML = items.map((a) => `
      <div class="attachment-item">
        <div>
          <div>${escapeHtml(a.file_name)}</div>
          <div class="meta">${formatBytes(a.size_bytes)} · ${formatDate(a.created_at)}</div>
        </div>
        <div style="display:flex;gap:.3rem">
          <button class="btn btn-ghost btn-sm" data-action="download-attachment" data-path="${escapeAttr(a.storage_path)}">下載</button>
          <button class="btn btn-danger btn-sm" data-action="del-attachment" data-id="${escapeAttr(a.id)}" data-path="${escapeAttr(a.storage_path)}">刪除</button>
        </div>
      </div>`).join('');
  } catch (err) {
    box.innerHTML = `<p class="login-message error">載入附件失敗：${escapeHtml(err.message)}</p>`;
  }
}

// ---------------------------------------------------------------------------
// Drag & drop (kanban)
// ---------------------------------------------------------------------------
function setupDragAndDrop() {
  document.addEventListener('dragstart', (e) => {
    const card = e.target.closest?.('.task-card');
    if (card) { card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; }
  });
  document.addEventListener('dragend', (e) => {
    const card = e.target.closest?.('.task-card');
    if (card) card.classList.remove('dragging');
  });

  $$('.task-list').forEach((list) => {
    list.addEventListener('dragover', (e) => {
      e.preventDefault();
      const dragging = document.querySelector('.task-card.dragging');
      if (!dragging) return;
      const after = getDragAfterElement(list, e.clientY);
      if (after == null) list.appendChild(dragging);
      else list.insertBefore(dragging, after);
    });
    list.addEventListener('drop', async (e) => {
      e.preventDefault();
      const dragging = document.querySelector('.task-card.dragging');
      if (!dragging) return;
      const id = dragging.dataset.taskId;
      const newStatus = list.dataset.status;
      const orderedIds = Array.from(list.querySelectorAll('.task-card')).map((el) => el.dataset.taskId);
      try {
        await db.tasks.update(id, { status: newStatus, is_done: newStatus === 'done' });
        await db.tasks.reorder(orderedIds);
        await refreshAll();
      } catch (err) {
        toast(`移動失敗：${err.message}`, 'error');
      }
    });
  });
}

function getDragAfterElement(container, y) {
  const items = [...container.querySelectorAll('.task-card:not(.dragging)')];
  return items.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) return { offset, element: child };
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// ---------------------------------------------------------------------------
// Git log
// ---------------------------------------------------------------------------
async function loadGitLog() {
  try {
    const res = await fetch(CONFIG.GIT_LOG_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const commits = Array.isArray(data.commits) ? data.commits : [];
    state.fileHistory = [];
    for (const commit of commits) {
      for (const file of (commit.files || [])) {
        state.fileHistory.push({
          sha: commit.shortSha || String(commit.sha || '').slice(0, 7),
          message: commit.subject || '',
          author: commit.author || '',
          date: commit.date || '',
          filename: file.filename,
          status: file.status || 'modified',
          additions: file.additions || 0,
          deletions: file.deletions || 0,
        });
      }
    }
    $('#gitLogMeta').textContent = data.generatedAt ? `產生時間 ${formatDate(data.generatedAt)}` : '';
  } catch (err) {
    state.fileHistory = [];
    $('#gitLogMeta').textContent = '（尚無 git-log.json，可執行 npm run gitlog）';
    console.warn('git-log load failed:', err);
  }
  renderFileList();
}

function renderFileList() {
  const search = ($('#fileSearch').value || '').toLowerCase();
  const type = $('#fileTypeFilter').value;
  const filtered = state.fileHistory.filter((it) => {
    const matches = !search || it.filename.toLowerCase().includes(search) || (it.message || '').toLowerCase().includes(search);
    const byType = !type || it.filename.toLowerCase().endsWith(type);
    return matches && byType;
  });

  $('#fileList').innerHTML = filtered.map((it) => `
    <div class="file-item">
      <div class="file-icon" style="background:${fileIconBg(it.filename)}">${fileIcon(it.filename)}</div>
      <div class="file-info">
        <div class="file-name">${escapeHtml(it.filename)}</div>
        <div class="file-meta">
          <span>${escapeHtml(it.message)}</span>
          <span>${formatDate(it.date)}</span>
          <span>${escapeHtml(it.author)}</span>
          <span>+${it.additions} -${it.deletions}</span>
        </div>
      </div>
      <span class="status-badge ${it.status === 'added' ? 'pass' : it.status === 'removed' ? 'fail' : 'mid'}">${escapeHtml(it.status)}</span>
    </div>`).join('') || '<p class="empty-state">無符合條件的檔案。</p>';
}

function fileIcon(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return { md: '📝', js: '📜', mjs: '📜', ts: '📜', json: '📋', svg: '🎨', png: '🖼️', jpg: '🖼️', txt: '📄', py: '🐍', html: '🌐', css: '🎨', lss: '⚙️', nsf: '🗄️' }[ext] || '📄';
}
function fileIconBg(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return { md: '#e0f2fe', js: '#fef3c7', mjs: '#fef3c7', ts: '#dbeafe', json: '#fce7f3', svg: '#f3e8ff', png: '#fef3c7', txt: '#f1f5f9', py: '#e0f2fe', nsf: '#fef2f2' }[ext] || '#f1f5f9';
}

// ---------------------------------------------------------------------------
// RAG report
// ---------------------------------------------------------------------------
async function loadRagReport() {
  try {
    const res = await fetch(CONFIG.RAG_REPORT_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const md = await res.text();
    state.ragData = parseRagMarkdown(md);
    $('#ragSource').textContent = `來源：${CONFIG.RAG_REPORT_URL}`;
  } catch (err) {
    state.ragData = null;
    $('#ragSource').textContent = '（無法載入 RAG 報告）';
    console.warn('RAG report load failed:', err);
  }
  renderRag();
}

function renderRag() {
  const data = state.ragData;
  if (!data) {
    $('#ragAccuracy').textContent = '--';
    $('#ragTopK').textContent = '--';
    $('#ragTestCases').textContent = '--';
    $('#ragTableBody').innerHTML = '';
    return;
  }
  $('#ragAccuracy').textContent = (data.max * 100).toFixed(1) + '%';
  $('#ragTopK').textContent = data.topK;
  $('#ragTestCases').textContent = data.testCases;
  $('#ragTableBody').innerHTML = data.results.map((r) => `
    <tr>
      <td>${escapeHtml(r.rank)}</td>
      <td>${escapeHtml(r.caseId)}</td>
      <td class="score-${r.status === 'pass' ? 'high' : r.status === 'mid' ? 'medium' : 'low'}">${r.score.toFixed(3)}</td>
      <td><span class="status-badge ${r.status === 'pass' ? 'pass' : r.status === 'mid' ? 'mid' : 'fail'}">${r.status === 'pass' ? '通過' : r.status === 'mid' ? '待改善' : '失敗'}</span></td>
    </tr>`).join('');
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
async function onLogin(e) {
  e.preventDefault();
  if (!client) return;
  const msg = $('#loginMessage');
  msg.textContent = '登入中…';
  msg.className = 'login-message';
  const { error } = await client.auth.signInWithPassword({
    email: $('#loginEmail').value.trim(),
    password: $('#loginPassword').value,
  });
  if (error) {
    msg.textContent = `登入失敗：${error.message}`;
    msg.className = 'login-message error';
  } else {
    msg.textContent = '';
    $('#loginForm').reset();
  }
}

// ---------------------------------------------------------------------------
// Local data tools
// ---------------------------------------------------------------------------
function onSeedDemo() {
  if (!usingLocal) return toast('僅本機模式提供示範資料', 'error');
  const added = seedDemoIfEmpty();
  toast(added ? '已載入示範資料' : '已有資料，未覆蓋', added ? 'success' : 'info');
  refreshAll();
}

function onClearData() {
  if (!usingLocal) return toast('清除只作用於本機模式', 'error');
  if (!confirm('確定清除所有本機資料？此操作無法復原。')) return;
  clearLocalData();
  state.projectId = null; state.caseId = null;
  refreshAll();
  toast('本機資料已清除', 'success');
}

function onExportData() {
  if (!usingLocal) return toast('匯出只支援本機模式', 'error');
  const blob = new Blob([JSON.stringify(exportLocalData(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `project-tracker-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function onImportData(e) {
  if (!usingLocal) { e.target.value = ''; return toast('匯入只支援本機模式', 'error'); }
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    importLocalData(payload);
    await refreshAll();
    toast('資料已匯入', 'success');
  } catch (err) {
    toast(`匯入失敗：${err.message}`, 'error');
  } finally {
    e.target.value = '';
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function selectOptions(values, selected, labels) {
  return values.map((v) => `<option value="${escapeAttr(v)}" ${v === selected ? 'selected' : ''}>${escapeHtml(labels?.[v] || v)}</option>`).join('');
}
function statusLabel(v) { return STATUS_LABELS[v] || v || '—'; }
function priorityLabel(v) { return PRIORITY_LABELS[v] || v || '—'; }

function normalizeColor(color) {
  if (!color) return '';
  return /^#[0-9a-f]{3,8}$/i.test(color) ? color : '';
}

function truncate(text, n) {
  const s = String(text || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return escapeHtml(String(dateStr));
  return d.toLocaleString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(text) { return escapeHtml(text); }

function debounce(fn, delay) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
}

function toast(message, type = 'info') {
  const root = $('#toastRoot');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
