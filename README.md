# 專案追蹤平台 (Project Case Tracker)

通用型個人專案追蹤平台，結構為 **專案 → 案件 → 子任務**。前端是純靜態網站，資料存放於 Supabase（Postgres + Auth + Storage），程式碼由 GitHub 版控，部署使用 GitHub Pages（Cloudflare Pages 為備選）。

> 這是通用工具，不是任何單一專案的專屬系統。WM、個人 AI 專案、其他工程專案都只是資料列。

## 功能

- 🗂️ **專案 / 案件 / 子任務** 三層 CRUD
- ✅ **看板**（子任務拖曳、狀態、優先級、期限、排序）
- 🔐 **Supabase Auth 登入**（關閉公開註冊；RLS 僅本人可存取）
- 📎 **附件**：私有 Storage 桶 + 簽名網址
- 📁 **Git 檔案異動記錄**：讀取建置時產生的 `data/git-log.json`
- 📑 **專案報告**：通用報告 + RAG 評估表（讀取 Markdown）
- 💾 未設定 Supabase 時自動進入 **本機示範模式**（localStorage）

## 架構

```
GitHub (程式碼/版控/CI)
        │ git push
        ▼
GitHub Pages (靜態前端，push 自動部署)
        │ Publishable Key + RLS
        ▼
Supabase (Postgres / Auth / Storage)   ← 不是網站主機
```

- Supabase **不托管前端網頁**；前端放在靜態主機（Cloudflare Pages / GitHub Pages / Netlify / Vercel）。
- 前端只使用 **Publishable (anon) Key**；`service_role` / Secret Key **永不進入前端**。
- 匿名使用者沒有任何資料存取權（無 `using (true)` 政策）。

## 快速開始（本機）

```bash
npm install          # 只有 devDependency (serve)，可選
cp config.example.js config.js   # 填入你的 Supabase URL 與 Publishable Key
npm run dev          # http://localhost:3000
```

若沒有 `config.js`，網站仍可啟動，會以 **本機示範模式** 執行（資料存 localStorage）。

### 環境變數 / 建置時注入

不要提交 `config.js`（已在 `.gitignore`）。正式環境由建置步驟產生：

```bash
SUPABASE_URL=https://xxxx.supabase.co \
SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx \
npm run build        # 產生 config.js
```

## 設定 Supabase

1. 建立 Supabase 專案。
2. 到 **SQL Editor** 執行 [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql)。
   - 建立 `profiles / projects / cases / tasks / reports / attachments`
   - 啟用 RLS（僅 `owner_id = auth.uid()`）
   - 建立私有 `attachments` bucket 與 Storage 政策
3. 到 **Authentication → Providers → Email**：關閉「Allow new users to sign up」，改由 **Users** 頁面手動新增帳號。
4. 到 **Project Settings → API** 取得 **Project URL** 與 **Publishable Key**，填入 `config.js` 或環境變數。

> 注意：舊式 `anon` key 與新式 `sb_publishable_...` 皆為公開金鑰，安全性由 RLS 決定。

## 部署（GitHub Pages）

Repo 推上 GitHub 後，由 [`.github/workflows/pages.yml`](.github/workflows/pages.yml) 自動建置與部署。

1. GitHub repo → **Settings → Secrets and variables → Actions → Variables**，新增：
   - `SUPABASE_URL`
   - `SUPABASE_PUBLISHABLE_KEY`

   （兩者都是可公開的 Publishable 資訊，因此使用 Variables 而非 Secrets；RLS 才是權限邊界。）
2. **Settings → Pages → Build and deployment → Source** 選擇 **GitHub Actions**。
3. 推送到 `main` 後，Actions 會產生 `config.js`、更新 `data/git-log.json`，並部署到
   `https://<帳號>.github.io/<repo>/`。

> 免費帳號的 GitHub Pages 需使用 **public repo**。本專案已將含公司資訊的
> `RAG驗證結果報告.md` 加入 `.gitignore`，公開站台改用去識別化的
> `RAG驗證結果報告.example.md`。

### 備選：Cloudflare Pages

Cloudflare Pages 免費方案支援私有 repo，設定方式相同（Build command `npm run build`、
輸出目錄 `/`，環境變數 `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY`）。

### Git 記錄

```bash
npm run gitlog
git add data/git-log.json && git commit -m "chore: update git log"
```

## 常用指令

```bash
npm run dev        # 本機靜態伺服器
npm run lint       # 語法檢查
npm test           # 本機資料層 / RAG 解析測試
node scripts/check-dom.mjs   # 檢查 app.js 使用的 DOM id 都存在
node scripts/gen-gitlog.mjs  # 產生 data/git-log.json
npm run build      # 由環境變數產生 config.js
npm run verify:supabase  # 唯讀檢查資料表是否已建立
```

## 資料模型

| 表 | 說明 | 關鍵欄位 |
|---|---|---|
| `profiles` | 使用者資料（對應 `auth.users`） | `id`, `email` |
| `projects` | 專案 | `owner_id`, `key`, `name`, `status` |
| `cases` | 案件 | `project_id`, `case_number`, `status`, `priority` |
| `tasks` | 子任務 | `case_id`, `status`, `priority`, `position`, `is_done` |
| `reports` | 專案報告（含 RAG 評估） | `project_id`, `kind`, `content_md` |
| `attachments` | 附件 metadata | `storage_path`, `case_id` / `task_id` |

三層關聯：`projects 1─N cases 1─N tasks`，刪除上層會串聯刪除下層。

## 安全注意事項

- 不提交任何憑證；`config.js` 與 `.env*` 已被忽略。
- 前端只用 Publishable Key；Secret / `service_role` Key 禁止放入前端。
- RLS 僅允許 `auth.uid()` 本人存取，未登入者無法讀寫。
- Storage 桶為私有，物件路徑以使用者 ID 為第一層。
- **公司機密 / 內網資料 / `.nsf` 不上傳** 到個人 Supabase 或公開網路。
- 真實 `RAG驗證結果報告.md` 含內網位址與工單編號，已排除在 Git 之外；公開站台只使用
  `RAG驗證結果報告.example.md`。

## 授權

MIT
