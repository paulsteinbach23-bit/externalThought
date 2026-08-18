// ───────────────────────────────────────────────
// SYNC — Supabase read/write layer (see PLAN.md, PLAN V2)
// Depends on: config.js (SUPABASE_URL/KEY), vendor/supabase.js,
// app.js (memos/captures/renderEntries/saveMemos/saveCaptures/etc.)
//
// V2-P0: extended from a single hardcoded 'voice_memos' table to a small
// entity registry. The 'legacy' entity is voice_memos/memos[] — untouched
// behavior, and the default entity for every public method so existing
// app.js call sites (Sync.upsert(memo), Sync.softDelete(id)) keep working
// unchanged.
//
// V2-P1: 'captures' is now owned by app.js (the `captures`/`saveCaptures()`
// globals, mirroring how `memos`/`saveMemos()` already work for 'legacy') —
// app.js writes new recordings into it directly.
//
// V2-P5: 'idea_documents' is now owned by app.js too (the `ideaDocuments`/
// `saveIdeaDocuments()` globals), for the same reason — app.js needs to
// create/edit documents directly, not just read them via Sync.ideaDocuments.
// ───────────────────────────────────────────────
const Sync = (() => {
  let client = null;
  let channel = null;
  let status = 'offline';
  let currentUser = null;

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

  // ── Legacy entity (voice_memos / memos[]) — mapping unchanged from pre-V2 ──
  function pathFromCategory(category) {
    const map = { 'Arbeit': 'A', 'Forschung': 'B', 'Business-Idee': 'C', 'Sonstiges': 'D' };
    return map[category] || 'D';
  }

  function mapRemoteToLocalLegacy(row) {
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
      done: !!row.done,
    };
  }

  function mapToRemoteLegacy(memo) {
    return {
      id: memo.id,
      updated_at: new Date(memo.updatedAt || Date.now()).toISOString(),
      source: memo.source || 'pwa',
      path: memo.path,
      title: memo.title,
      transcript: memo.text,
      body_html: memo.html || null,
      done: !!memo.done,
      user_id: currentUser ? currentUser.id : null,
    };
  }

  // ── captures entity (V2-P0: schema only, no app.js UI yet) ──
  function mapRemoteToLocalCapture(row) {
    return {
      id: row.id,
      ts: Date.parse(row.created_at),
      updatedAt: row.updated_at ? Date.parse(row.updated_at) : Date.parse(row.created_at),
      source: row.source || 'pwa',
      kind: row.kind,
      transcript: row.transcript || '',
      title: row.title || '',
      done: !!row.done,
      dueDate: row.due_date || null,
      filed: !!row.filed,
      ideaDocumentId: row.idea_document_id || null,
      legacyPath: row.legacy_path || null,
    };
  }

  function mapToRemoteCapture(c) {
    return {
      id: c.id,
      updated_at: new Date(c.updatedAt || Date.now()).toISOString(),
      source: c.source || 'pwa',
      kind: c.kind,
      transcript: c.transcript,
      title: c.title || null,
      done: !!c.done,
      due_date: c.dueDate || null,
      filed: !!c.filed,
      idea_document_id: c.ideaDocumentId || null,
      legacy_path: c.legacyPath || null,
      user_id: currentUser ? currentUser.id : null,
    };
  }

  // ── idea_documents entity (V2-P0: schema only, no app.js UI yet) ──
  function mapRemoteToLocalIdea(row) {
    return {
      id: row.id,
      ts: Date.parse(row.created_at),
      updatedAt: row.updated_at ? Date.parse(row.updated_at) : Date.parse(row.created_at),
      title: row.title || '',
      html: row.body_html || '',
      canvas: row.canvas || { nodes: [], edges: [] },
      viewport: row.viewport || null,
    };
  }

  function mapToRemoteIdea(doc) {
    return {
      id: doc.id,
      updated_at: new Date(doc.updatedAt || Date.now()).toISOString(),
      title: doc.title,
      body_html: doc.html || null,
      canvas: doc.canvas || { nodes: [], edges: [] },
      viewport: doc.viewport || null,
      user_id: currentUser ? currentUser.id : null,
    };
  }

  // ── Entity registry ──────────────────────────────
  // 'legacy' must stay the default entity on every public method below —
  // that's what keeps existing app.js call sites (Sync.upsert(memo), no
  // second argument) working unchanged.
  const ENTITIES = {
    legacy: {
      table: 'voice_memos',
      arrayRef: () => memos,
      setArray: (arr) => { memos = arr; },
      save: () => saveMemos(),
      mapToLocal: mapRemoteToLocalLegacy,
      mapToRemote: mapToRemoteLegacy,
    },
    captures: {
      table: 'captures',
      arrayRef: () => captures,
      setArray: (arr) => { captures = arr; },
      save: () => saveCaptures(),
      mapToLocal: mapRemoteToLocalCapture,
      mapToRemote: mapToRemoteCapture,
    },
    idea_documents: {
      table: 'idea_documents',
      arrayRef: () => ideaDocuments,
      setArray: (arr) => { ideaDocuments = arr; },
      save: () => saveIdeaDocuments(),
      mapToLocal: mapRemoteToLocalIdea,
      mapToRemote: mapToRemoteIdea,
    },
  };

  function entityOf(key) {
    const e = ENTITIES[key];
    if (!e) throw new Error(`Sync: unknown entity "${key}"`);
    return e;
  }

  function mergeRowFor(entityKey, row) {
    const e = entityOf(entityKey);
    const arr = e.arrayRef();
    if (row.deleted_at) {
      e.setArray(arr.filter(x => x.id !== row.id));
      e.save();
      return;
    }
    const mapped = e.mapToLocal(row);
    const idx = arr.findIndex(x => x.id === row.id);
    if (idx === -1) arr.unshift(mapped);
    else arr[idx] = mapped;
    e.setArray(arr);
    e.save();
  }

  async function pullEntity(entityKey) {
    const e = entityOf(entityKey);
    const { data, error } = await client
      .from(e.table)
      .select('*')
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    if (error) {
      console.warn(`Sync.pull(${entityKey}) failed:`, error.message);
      return false;
    }
    e.setArray(data.map(e.mapToLocal));
    e.save();
    return true;
  }

  // Raw network calls — throw on any failure (network or Postgrest error).
  // No outbox handling here; callers below decide what to do with the failure.
  async function _upsertRemoteFor(entityKey, item) {
    const e = entityOf(entityKey);
    const { error } = await client.from(e.table).upsert(e.mapToRemote(item), { onConflict: 'id' });
    if (error) throw error;
  }

  async function _softDeleteRemoteFor(entityKey, id) {
    const e = entityOf(entityKey);
    const { error } = await client
      .from(e.table)
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
  }

  async function pull() {
    if (!client) return;
    setStatus('syncing');
    const ok = await pullEntity('legacy');
    if (!ok) { setStatus('offline'); return; }
    renderEntries();
    await pullEntity('captures');
    await pullEntity('idea_documents');
    setStatus('online');
  }

  function subscribe() {
    if (!client) return;
    channel = client.channel('sync_changes');
    Object.keys(ENTITIES).forEach((key) => {
      const e = ENTITIES[key];
      channel = channel.on('postgres_changes', { event: '*', schema: 'public', table: e.table }, (payload) => {
        const row = payload.eventType === 'DELETE' ? payload.old : payload.new;
        if (!row) return;
        mergeRowFor(key, row);
        renderEntries();
      });
    });
    channel.subscribe();
  }

  function resubscribe() {
    if (channel) client.removeChannel(channel);
    subscribe();
  }

  // Public write API — used by app.js. Queues to the outbox on failure.
  // `entity` defaults to 'legacy' so existing single-argument call sites
  // (Sync.upsert(memo), Sync.softDelete(id)) are unaffected.
  async function upsert(item, entity = 'legacy') {
    if (!client) { queueOutbox('upsert', item, entity); return; }
    try {
      await _upsertRemoteFor(entity, item);
    } catch (err) {
      console.warn(`Sync.upsert(${entity}) failed, queuing:`, err.message || err);
      queueOutbox('upsert', item, entity);
    }
  }

  async function softDelete(id, entity = 'legacy') {
    if (!client) { queueOutbox('delete', { id }, entity); return; }
    try {
      await _softDeleteRemoteFor(entity, id);
    } catch (err) {
      console.warn(`Sync.softDelete(${entity}) failed, queuing:`, err.message || err);
      queueOutbox('delete', { id }, entity);
    }
  }

  function queueOutbox(op, payload, entity = 'legacy') {
    const outbox = getOutbox();
    outbox.push({ op, entity, payload, ts: Date.now() });
    setOutbox(outbox);
  }

  // Drains the outbox against the raw remote calls — a failure here leaves
  // the item in `remaining` instead of re-queuing a duplicate via queueOutbox.
  // Items queued before this entity field existed have no `entity` key —
  // default them to 'legacy' so nothing already sitting in a user's outbox
  // breaks on this deploy.
  async function flushOutbox() {
    if (!client) return;
    const outbox = getOutbox();
    if (!outbox.length) return;
    const remaining = [];
    for (const item of outbox) {
      const entityKey = item.entity || 'legacy';
      try {
        if (item.op === 'upsert') await _upsertRemoteFor(entityKey, item.payload);
        else if (item.op === 'delete') await _softDeleteRemoteFor(entityKey, item.payload.id);
      } catch (err) {
        remaining.push(item);
      }
    }
    setOutbox(remaining);
  }

  // Creates the Supabase client on first use and wires up an auth-state
  // listener that keeps `currentUser` current — every mapToRemote* function
  // above reads it to stamp `user_id` on writes. Idempotent: safe to call
  // from getSession()/onAuthChange() before init() has run, and again from
  // init() itself once a session is confirmed.
  function ensureClient() {
    if (client) return true;
    if (typeof SUPABASE_URL === 'undefined' || typeof SUPABASE_ANON_KEY === 'undefined') {
      console.warn('Sync: config.js missing, staying offline (local-only).');
      setStatus('offline');
      return false;
    }
    client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    client.auth.onAuthStateChange((_event, session) => {
      currentUser = session ? session.user : null;
    });
    return true;
  }

  async function getSession() {
    if (!ensureClient()) return null;
    const { data } = await client.auth.getSession();
    currentUser = data.session ? data.session.user : null;
    return data.session;
  }

  function onAuthChange(cb) {
    if (!ensureClient()) return;
    client.auth.onAuthStateChange((event, session) => cb(event, session));
  }

  // Password login, not magic link — completes synchronously with no email
  // round-trip and no redirect-URL to configure per device/origin.
  async function signInWithPassword(email, password) {
    if (!ensureClient()) throw new Error('Supabase ist nicht konfiguriert (config.js fehlt).');
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    currentUser = data.session ? data.session.user : null;
    return data.session;
  }

  async function signOut() {
    if (!client) return;
    await client.auth.signOut();
    currentUser = null;
  }

  // Starts data sync — only call this once a session is confirmed (see
  // app.js's bootApp()). Auth itself (getSession/onAuthChange/signInWithPassword)
  // works before this via ensureClient(), independent of whether sync has
  // started.
  function init() {
    if (!ensureClient()) return;
    pull();
    subscribe();
    flushOutbox();
    window.addEventListener('online', flushOutbox);
  }

  return {
    init, pull, subscribe, resubscribe, upsert, softDelete, flushOutbox,
    getSession, onAuthChange, signInWithPassword, signOut,
    get status() { return status; },
    get captures() { return captures; },
    get ideaDocuments() { return ideaDocuments; },
  };
})();
