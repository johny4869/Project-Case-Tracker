// Local development config template.
//
// Copy this file to `config.js` for local development, or let the build step
// generate `config.js` from environment variables (see scripts/gen-config.mjs).
//
// `config.js` is intentionally git-ignored. Never commit real project keys.
//
// NOTE: The Supabase publishable key is designed to be exposed to the browser.
// Security is enforced by Row Level Security (RLS), not by hiding this key.
// NEVER put a service_role / secret key here.

export const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_your_key';
export const GIT_LOG_URL = 'data/git-log.json';
export const RAG_REPORT_URL = 'RAG驗證結果報告.md';
