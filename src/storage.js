// Supabase Storage helpers for the private `attachments` bucket.
// Object path convention: {userId}/{projectId}/{caseId|taskId|general}/{uuid}_{filename}
// The first path segment is the user id so Storage RLS can enforce ownership.

const BUCKET = 'attachments';

function safeName(name) {
  return String(name || 'file')
    .replace(/[^\w.\-()\u4e00-\u9fff]+/g, '_')
    .slice(0, 120);
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'obj-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

export async function uploadAttachment(client, file, { userId, projectId, caseId, taskId }) {
  if (!client) throw new Error('附件功能需要連線 Supabase。');
  if (!userId) throw new Error('請先登入才能上傳附件。');
  const scope = caseId || taskId || 'general';
  const path = `${userId}/${projectId}/${scope}/${uuid()}_${safeName(file.name)}`;

  const { error } = await client.storage.from(BUCKET).upload(path, file, {
    upsert: false,
    contentType: file.type || 'application/octet-stream',
  });
  if (error) throw error;

  return {
    storage_path: path,
    file_name: file.name,
    mime_type: file.type || 'application/octet-stream',
    size_bytes: file.size,
  };
}

export async function getSignedUrl(client, path, expiresIn = 3600) {
  if (!client) throw new Error('附件功能需要連線 Supabase。');
  const { data, error } = await client.storage.from(BUCKET).createSignedUrl(path, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}

export async function removeObject(client, path) {
  if (!client) return;
  const { error } = await client.storage.from(BUCKET).remove([path]);
  if (error) throw error;
}

export function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
