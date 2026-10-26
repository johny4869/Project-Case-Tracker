import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

/**
 * Create a Supabase browser client.
 * Only the publishable (anon) key belongs here. Never a service_role key.
 * Returns null when the project is not configured, enabling local demo mode.
 */
export function createSupabaseClient(url, publishableKey) {
  if (!url || !publishableKey) return null;
  if (String(publishableKey).startsWith('sb_secret_') || String(publishableKey).includes('service_role')) {
    console.error('Refusing to use a secret/service_role key in the browser.');
    return null;
  }
  return createClient(url, publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
}
