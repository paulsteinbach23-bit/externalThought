// ───────────────────────────────────────────────
// SYNC — Supabase read/write layer (see PLAN.md)
// Depends on: config.js (SUPABASE_URL/KEY), vendor/supabase.js, app.js (memos/renderEntries/etc.)
// ───────────────────────────────────────────────
const Sync = (() => {
  let client = null;
  let channel = null;
  let status = 'offline';

  const OUTBOX_KEY = 'memo_outbox';

  function getOutbox() {
    return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]');
  }

  function setOutbox(items) {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(items));
  }

  const STATUS_LABELS = { online: 'SYNC OK', offline: 'OFFLINE', syncing: 'SYNC …' };

  function setStatus(s) {
    status = s;
    const dot = document.getElementById('syncDot');
    const text = document.getElementById('syncStatusText');
    if (dot) dot.className = 'sync-dot ' + s;
    if (text) text.textContent = STATUS_LABELS[s] || s;
  }

  // Remote row → local memo shape (PLAN.md §4.2 mapping table)
  function mapRemoteToLocal(row) {
    return {
      id: row.id,
      ts: Date.parse(row.created_at),
      updatedAt: row.updated_at ? Date.parse(row.updated_at) : Date.parse(row.created_at),
      title: row.title || row.summary || '',
      text: row.transcript || '',
      summary: row.summary || '',
      html: row.body_html || undefined,
      path: row.path || pathFromCategory(row.category),
      source: row.source || 'mac',
      isNew: false,
    };
  }

  function pathFromCategory(category) {
    const map = { 'Arbeit': 'A', 'Forschung': 'B', 'Business-Idee': 'C', 'Sonstiges': 'D' };
    return map[category] || 'D';
  }

  function mergeRow(row) {
    if (row.deleted_at) {
      memos = memos.filter(m => m.id !== row.id);
      saveMemos();
      return;
    }
    const mapped = mapRemoteToLocal(row);
    const idx = memos.findIndex(m => m.id === row.id);
    if (idx === -1) memos.unshift(mapped);
    else memos[idx] = mapped;
    saveMemos();
  }

  async function pull() {
    if (!client) return;
    setStatus('syncing');
    const { data, error } = await client
      .from('voice_memos')
      .select('*')
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    if (error) {
      console.warn('Sync.pull failed:', error.message);
      setStatus('offline');
      return;
    }
    memos = data.map(mapRemoteToLocal);
    saveMemos();
    renderEntries();
    setStatus('online');
  }

  function subscribe() {
    if (!client) return;
    channel = client
      .channel('voice_memos_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'voice_memos' }, (payload) => {
        const row = payload.eventType === 'DELETE' ? payload.old : payload.new;
        if (!row) return;
        mergeRow(row);
        renderEntries();
      })
      .subscribe();
  }

  function resubscribe() {
    if (channel) client.removeChannel(channel);
    subscribe();
  }

  // Raw network calls — throw on any failure (network or Postgrest error).
  // No outbox handling here; callers below decide what to do with the failure.
  async function _upsertRemote(memo) {
    const { error } = await client.from('voice_memos').upsert({
      id: memo.id,
      updated_at: new Date(memo.updatedAt || Date.now()).toISOString(),
      source: memo.source || 'pwa',
      path: memo.path,
      title: memo.title,
      transcript: memo.text,
      body_html: memo.html || null,
    }, { onConflict: 'id' });
    if (error) throw error;
  }

  async function _softDeleteRemote(id) {
    const { error } = await client
      .from('voice_memos')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  }

  // Public write API — used by app.js. Queues to the outbox on failure.
  async function upsert(memo) {
    if (!client) { queueOutbox('upsert', memo); return; }
    try {
      await _upsertRemote(memo);
    } catch (err) {
      console.warn('Sync.upsert failed, queuing:', err.message || err);
      queueOutbox('upsert', memo);
    }
  }

  async function softDelete(id) {
    if (!client) { queueOutbox('delete', { id }); return; }
    try {
      await _softDeleteRemote(id);
    } catch (err) {
      console.warn('Sync.softDelete failed, queuing:', err.message || err);
      queueOutbox('delete', { id });
    }
  }

  function queueOutbox(op, payload) {
    const outbox = getOutbox();
    outbox.push({ op, payload, ts: Date.now() });
    setOutbox(outbox);
  }

  // Drains the outbox against the raw remote calls — a failure here leaves
  // the item in `remaining` instead of re-queuing a duplicate via queueOutbox.
  async function flushOutbox() {
    if (!client) return;
    const outbox = getOutbox();
    if (!outbox.length) return;
    const remaining = [];
    for (const item of outbox) {
      try {
        if (item.op === 'upsert') await _upsertRemote(item.payload);
        else if (item.op === 'delete') await _softDeleteRemote(item.payload.id);
      } catch (err) {
        remaining.push(item);
      }
    }
    setOutbox(remaining);
  }

  function init() {
    if (typeof SUPABASE_URL === 'undefined' || typeof SUPABASE_ANON_KEY === 'undefined') {
      console.warn('Sync.init: config.js missing, staying offline (local-only).');
      setStatus('offline');
      return;
    }
    client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    pull();
    subscribe();
    flushOutbox();
    window.addEventListener('online', flushOutbox);
  }

  return { init, pull, subscribe, resubscribe, upsert, softDelete, flushOutbox, get status() { return status; } };
})();
