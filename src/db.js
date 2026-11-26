// Optional Supabase persistence. If env vars are missing, every call is a no-op
// so local development works without any setup. Failures are logged, never thrown:
// the game must keep running even if the DB is unreachable.

const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;

const supabase = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;

if (!supabase) console.log('[db] SUPABASE_URL / SUPABASE_SECRET_KEY not set; persistence disabled');

async function roomCreated(code) {
  if (!supabase) return null;
  const { data, error } = await supabase.from('rooms').insert({ code }).select('id').single();
  if (error) {
    console.error('[db] roomCreated failed:', error.message);
    return null;
  }
  return data.id;
}

async function roomEnded(id) {
  if (!supabase || !id) return;
  const { error } = await supabase.from('rooms').update({ ended_at: new Date().toISOString() }).eq('id', id);
  if (error) console.error('[db] roomEnded failed:', error.message);
}

module.exports = { enabled: !!supabase, roomCreated, roomEnded };
