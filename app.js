// ───────────────────────────────────────────────
// THEME
// ───────────────────────────────────────────────
const THEME_COLORS = { dark: '#17140f', light: '#f3ede1' };

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.getElementById('themeColorMeta');
  if (meta) meta.content = THEME_COLORS[theme] || THEME_COLORS.light;
}

function initTheme() {
  applyTheme(localStorage.getItem('memo_theme') || 'light');
}

function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  localStorage.setItem('memo_theme', next);
}

initTheme();

// ───────────────────────────────────────────────
// STATE
// ───────────────────────────────────────────────

// One-time reset: Supabase is now the source of truth, old local-only memos are obsolete.
if (!localStorage.getItem('memo_schema_v2')) {
  const old = localStorage.getItem('voice_memos');
  if (old) localStorage.setItem('voice_memos_legacy_backup', old);
  localStorage.removeItem('voice_memos');
  localStorage.setItem('memo_schema_v2', '1');
}

let memos = JSON.parse(localStorage.getItem('voice_memos') || '[]');
let captures = JSON.parse(localStorage.getItem('captures') || '[]');
let ideaDocuments = JSON.parse(localStorage.getItem('idea_documents') || '[]');
let currentView = 'memos'; // 'memos' | 'todos' | 'inbox' | 'docs'
let sortOrder = 'newest';
let editorId = null;
let editorMode = 'memo'; // 'memo' | 'idea' — which collection saveEditor()/closeEditor() act on
let mediaRecorder = null;
let audioChunks = [];
let recognition = null;
let isRecording = false;
let liveTranscript = '';
let liveInterim = '';

function saveMemos() {
  localStorage.setItem('voice_memos', JSON.stringify(memos));
}

function saveCaptures() {
  localStorage.setItem('captures', JSON.stringify(captures));
}

function saveIdeaDocuments() {
  localStorage.setItem('idea_documents', JSON.stringify(ideaDocuments));
}

// ── PATH HELPERS — legacy A–E memos only, kept for the old-memos view ──
// until it's fully superseded by the to-do list (V2-P4) and inbox (V2-P5).
function getPathName(id) {
  if (id === 'A') return 'Work';
  if (id === 'B') return 'Research';
  if (id === 'C') return 'Business Ideas';
  if (id === 'D') return 'Sonstiges';
  if (id === 'E') return 'To-Do';
  return id;
}

function getPathColor(id) {
  if (id === 'A') return 'var(--accent-a)';
  if (id === 'B') return 'var(--accent-b)';
  if (id === 'C') return 'var(--accent-c)';
  if (id === 'D') return 'var(--accent-d)';
  if (id === 'E') return 'var(--accent-rec)';
  return '#888';
}

// Returns the entry-path-tag HTML for a given path id
function pathTagHtml(id) {
  const dot = `<span style="width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block"></span>`;
  const name = escHtml(getPathName(id).toUpperCase());
  if (['A','B','C','D','E'].includes(id)) {
    return `<div class="entry-path-tag tag-${id.toLowerCase()}">${dot}${name}</div>`;
  }
  const color = getPathColor(id);
  return `<div class="entry-path-tag" style="color:${color};">${dot}${name}</div>`;
}

// Applies path-tag styles to an existing DOM element
function applyPathTagStyle(el, id) {
  const dot = `<span style="width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block"></span>`;
  const name = escHtml(getPathName(id).toUpperCase());
  if (['A','B','C','D','E'].includes(id)) {
    el.className = (el.className.replace(/\btag-[a-e]\b/g, '').trim()) + ' tag-' + id.toLowerCase();
    el.removeAttribute('style');
  } else {
    const color = getPathColor(id);
    el.className = el.className.replace(/\btag-[a-e]\b/g, '').trim();
    el.style.cssText = `color:${color};`;
  }
  el.innerHTML = dot + name;
}

// ───────────────────────────────────────────────
// RENDER — dispatches to the current view (see setView())
// ───────────────────────────────────────────────
function renderEntries() {
  const search = document.getElementById('searchInput').value.toLowerCase();
  const newDocBtn = document.getElementById('newDocBtn');
  if (newDocBtn) newDocBtn.style.display = currentView === 'docs' ? '' : 'none';

  if (currentView === 'todos') renderTodosList(search);
  else if (currentView === 'inbox') renderInboxList(search);
  else if (currentView === 'docs') renderDocsList(search);
  else renderMemosList(search);
}

function setView(view) {
  currentView = view;
  document.querySelectorAll('.view-tab').forEach(el => {
    el.classList.toggle('active', el.dataset.view === view);
  });
  renderEntries();
}

function emptyStateHtml(label, hint) {
  return `
    <div class="empty-state">
      <div class="icon">◎</div>
      <p>${label}</p>
      <p style="font-size:10px; opacity:0.5;">${hint}</p>
    </div>`;
}

function stripHtml(html) {
  const div = document.createElement('div');
  div.innerHTML = html || '';
  return div.textContent || '';
}

function dateGroupKey(ts) {
  return new Date(ts).toLocaleDateString('en-GB', {weekday:'long', year:'numeric', month:'long', day:'numeric'});
}

function renderMemosList(search) {
  const container = document.getElementById('entries');

  let filtered = memos.filter(m => {
    if (search && !m.title.toLowerCase().includes(search) && !m.text.toLowerCase().includes(search)) return false;
    return true;
  });

  filtered.sort((a,b) => sortOrder === 'newest' ? b.ts - a.ts : a.ts - b.ts);

  document.getElementById('stat-total').textContent = memos.length;

  if (filtered.length === 0) {
    container.innerHTML = emptyStateHtml('NO MEMOS FOUND', 'Record your first memo →');
    return;
  }

  // Group by date
  const groups = {};
  filtered.forEach(m => {
    const key = dateGroupKey(m.ts);
    if (!groups[key]) groups[key] = [];
    groups[key].push(m);
  });

  let html = '';
  for (const [date, items] of Object.entries(groups)) {
    html += `<div class="date-group-label">${date}</div>`;
    items.forEach(m => {
      const time = new Date(m.ts).toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'});
      const preview = m.summary || m.text;
      const isTodo = m.path === 'E';
      const isDone = isTodo && !!m.done;
      const checkbox = isTodo
        ? `<button class="memo-checkbox${isDone?' checked':''}" onclick="toggleMemoDone('${m.id}', event)" aria-label="Erledigt"></button>`
        : '';
      html += `
        <div class="entry-card${m.isNew?' is-new':''}${isDone?' is-done':''}" onclick="navigateToDetail('${m.id}')">
          <div>
            ${pathTagHtml(m.path)}
            <div class="entry-title-row">
              ${checkbox}
              <div class="entry-title">${highlight(m.title, search)}</div>
            </div>
            <div class="entry-preview">${highlight(preview.substring(0,140), search)}${preview.length>140?'…':''}</div>
          </div>
          <div class="entry-meta">
            ${time}
            <span class="source-badge">${m.source === 'pwa' ? 'PWA' : 'MAC'}</span>
          </div>
        </div>`;
    });
  }

  container.innerHTML = html;
}

function renderTodosList(search) {
  const container = document.getElementById('entries');

  let items = captures.filter(c => c.kind === 'todo');
  document.getElementById('stat-total').textContent = items.length;

  items = items.filter(c => {
    if (!search) return true;
    return (c.title || '').toLowerCase().includes(search) || (c.transcript || '').toLowerCase().includes(search);
  });
  items.sort((a,b) => sortOrder === 'newest' ? b.ts - a.ts : a.ts - b.ts);

  if (items.length === 0) {
    container.innerHTML = emptyStateHtml('NO TO-DOS FOUND', 'Sag "Aufgabe …" oder "Todo …" beim Aufnehmen →');
    return;
  }

  // Group: Heute / Diese Woche / Älter
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfWeek = startOfToday - 6 * 86400000;
  const groups = { 'HEUTE': [], 'DIESE WOCHE': [], 'ÄLTER': [] };
  items.forEach(c => {
    if (c.ts >= startOfToday) groups['HEUTE'].push(c);
    else if (c.ts >= startOfWeek) groups['DIESE WOCHE'].push(c);
    else groups['ÄLTER'].push(c);
  });

  let html = '';
  for (const [label, group] of Object.entries(groups)) {
    if (!group.length) continue;
    html += `<div class="date-group-label">${label}</div>`;
    group.forEach(c => {
      const time = new Date(c.ts).toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'});
      const title = c.title || c.transcript.slice(0, 60);
      const isDone = !!c.done;
      html += `
        <div class="entry-card${isDone?' is-done':''}" onclick="navigateToCaptureDetail('${c.id}')">
          <div>
            <div class="entry-title-row">
              <button class="memo-checkbox${isDone?' checked':''}" onclick="toggleCaptureDone('${c.id}', event)" aria-label="Erledigt"></button>
              <div class="entry-title">${highlight(title, search)}</div>
            </div>
            <div class="entry-preview">${highlight(c.transcript.substring(0,140), search)}${c.transcript.length>140?'…':''}</div>
          </div>
          <div class="entry-meta">
            ${time}
            <span class="source-badge">${c.source === 'pwa' ? 'PWA' : 'MAC'}</span>
          </div>
        </div>`;
    });
  }

  container.innerHTML = html;
}

function renderInboxList(search) {
  const container = document.getElementById('entries');

  let items = captures.filter(c => c.kind === 'idea' && !c.filed);
  document.getElementById('stat-total').textContent = items.length;

  items = items.filter(c => {
    if (!search) return true;
    return (c.title || '').toLowerCase().includes(search) || (c.transcript || '').toLowerCase().includes(search);
  });
  items.sort((a,b) => sortOrder === 'newest' ? b.ts - a.ts : a.ts - b.ts);

  if (items.length === 0) {
    container.innerHTML = emptyStateHtml('INBOX LEER', 'Unbearbeitete Ideen landen hier →');
    return;
  }

  const groups = {};
  items.forEach(c => {
    const key = dateGroupKey(c.ts);
    if (!groups[key]) groups[key] = [];
    groups[key].push(c);
  });

  let html = '';
  for (const [date, group] of Object.entries(groups)) {
    html += `<div class="date-group-label">${date}</div>`;
    group.forEach(c => {
      const time = new Date(c.ts).toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'});
      const title = c.title || c.transcript.slice(0, 60);
      html += `
        <div class="entry-card" onclick="navigateToCaptureDetail('${c.id}')">
          <div>
            <div class="entry-title-row">
              <div class="entry-title">${highlight(title, search)}</div>
            </div>
            <div class="entry-preview">${highlight(c.transcript.substring(0,140), search)}${c.transcript.length>140?'…':''}</div>
          </div>
          <div class="entry-meta">
            ${time}
            <span class="source-badge">${c.source === 'pwa' ? 'PWA' : 'MAC'}</span>
          </div>
        </div>`;
    });
  }

  container.innerHTML = html;
}

function renderDocsList(search) {
  const container = document.getElementById('entries');

  document.getElementById('stat-total').textContent = ideaDocuments.length;

  let items = ideaDocuments.filter(d => {
    if (!search) return true;
    return (d.title || '').toLowerCase().includes(search) || stripHtml(d.html).toLowerCase().includes(search);
  });
  items.sort((a,b) => sortOrder === 'newest' ? b.updatedAt - a.updatedAt : a.updatedAt - b.updatedAt);

  if (items.length === 0) {
    container.innerHTML = emptyStateHtml('NOCH KEINE DOKUMENTE', '„+ NEU" erstellt dein erstes Ideen-Dokument →');
    return;
  }

  const groups = {};
  items.forEach(d => {
    const key = dateGroupKey(d.updatedAt);
    if (!groups[key]) groups[key] = [];
    groups[key].push(d);
  });

  let html = '';
  for (const [date, group] of Object.entries(groups)) {
    html += `<div class="date-group-label">${date}</div>`;
    group.forEach(d => {
      const time = new Date(d.updatedAt).toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'});
      const preview = stripHtml(d.html);
      html += `
        <div class="entry-card" onclick="openIdeaEditor('${d.id}')">
          <div>
            <div class="entry-title-row">
              <div class="entry-title">${highlight(d.title, search)}</div>
            </div>
            <div class="entry-preview">${highlight(preview.substring(0,140), search)}${preview.length>140?'…':''}</div>
          </div>
          <div class="entry-meta">
            ${time}
          </div>
        </div>`;
    });
  }

  container.innerHTML = html;
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function highlight(text, query) {
  if (!query) return escHtml(text);
  const esc = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(${esc})`, 'gi');
  return text.replace(re, '\x00$1\x00').split('\x00').map((part, i) =>
    i % 2 === 1 ? `<mark>${escHtml(part)}</mark>` : escHtml(part)
  ).join('');
}

function toggleSort() {
  sortOrder = sortOrder === 'newest' ? 'oldest' : 'newest';
  document.getElementById('sortToggle').textContent = sortOrder === 'newest' ? '↓ NEU' : '↑ ALT';
  renderEntries();
}

function copyMemo(id, e) {
  if (e) e.stopPropagation();
  const m = memos.find(x=>x.id===id);
  if (m) navigator.clipboard.writeText(m.text);
}

function downloadMemo(id, e) {
  if (e) e.stopPropagation();
  const m = memos.find(x=>x.id===id);
  if (!m) return;
  const blob = new Blob([`MEMO // ${m.title}\nPath: ${getPathName(m.path)}\nDate: ${new Date(m.ts).toLocaleString()}\n\n${m.text}`], {type:'text/plain'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = sanitizeFilename(m.title) + '.txt';
  a.click();
  URL.revokeObjectURL(url);
}

function deleteMemo(id, e) {
  if (e) e.stopPropagation();
  if (!confirm('Delete this memo?')) return;
  memos = memos.filter(x=>x.id!==id);
  saveMemos();
  if (typeof Sync !== 'undefined') Sync.softDelete(id);
  renderEntries();
  if (location.hash === '#memo/' + id) navigateBack();
}

function toggleMemoDone(id, e) {
  if (e) e.stopPropagation();
  const memo = memos.find(x=>x.id===id);
  if (!memo) return;
  memo.done = !memo.done;
  memo.updatedAt = Date.now();
  saveMemos();
  if (typeof Sync !== 'undefined') Sync.upsert(memo);
  renderEntries();
  if (location.hash === '#memo/' + id) {
    const checkboxEl = document.getElementById('detailCheckbox');
    if (checkboxEl) checkboxEl.classList.toggle('checked', !!memo.done);
    document.getElementById('detailTitle').classList.toggle('is-done', !!memo.done);
  }
}

function copyCapture(id, e) {
  if (e) e.stopPropagation();
  const c = captures.find(x=>x.id===id);
  if (c) navigator.clipboard.writeText(c.transcript);
}

function downloadCapture(id, e) {
  if (e) e.stopPropagation();
  const c = captures.find(x=>x.id===id);
  if (!c) return;
  const kindLabel = c.kind === 'todo' ? 'To-Do' : 'Idee';
  const blob = new Blob([`${kindLabel.toUpperCase()} // ${c.title}\nDate: ${new Date(c.ts).toLocaleString()}\n\n${c.transcript}`], {type:'text/plain'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = sanitizeFilename(c.title) + '.txt';
  a.click();
  URL.revokeObjectURL(url);
}

function deleteCapture(id, e) {
  if (e) e.stopPropagation();
  if (!confirm('Eintrag löschen?')) return;
  captures = captures.filter(x=>x.id!==id);
  saveCaptures();
  if (typeof Sync !== 'undefined') Sync.softDelete(id, 'captures');
  renderEntries();
  if (location.hash === '#capture/' + id) navigateBack();
}

function toggleCaptureDone(id, e) {
  if (e) e.stopPropagation();
  const c = captures.find(x=>x.id===id);
  if (!c) return;
  c.done = !c.done;
  c.updatedAt = Date.now();
  saveCaptures();
  if (typeof Sync !== 'undefined') Sync.upsert(c, 'captures');
  renderEntries();
  if (location.hash === '#capture/' + id) {
    const checkboxEl = document.getElementById('detailCheckbox');
    if (checkboxEl) checkboxEl.classList.toggle('checked', !!c.done);
    document.getElementById('detailTitle').classList.toggle('is-done', !!c.done);
  }
}

function sanitizeFilename(str) {
  return str.replace(/[^a-z0-9_\-\s]/gi,'').replace(/\s+/g,'_').toLowerCase().substring(0,60);
}

// ───────────────────────────────────────────────
// FAB — tap and talk immediately, no picker
// ───────────────────────────────────────────────
function onFabClick() {
  if (isRecording) stopRecording();
  else startRecording();
}

// ───────────────────────────────────────────────
// RECORDING — Web Speech API
// ───────────────────────────────────────────────
function startRecording() {
  if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
    alert('Your browser does not support the Web Speech API.\nPlease use Chrome or Edge for voice recording.\n\nAlternatively, you can type your memo below using the manual input (double-click any empty area).');
    showManualInput();
    return;
  }

  if (navigator.vibrate) navigator.vibrate(50);

  liveTranscript = '';
  liveInterim = '';
  isRecording = true;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'de-DE';

  recognition.onresult = (e) => {
    let interim = '';
    let final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) final += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    liveTranscript += final;
    liveInterim = interim;
    document.getElementById('modalStatus').innerHTML = `
      <div style="line-height:1.7; font-size:11px;">
        <span style="color:var(--text-dim)">${escHtml(liveTranscript)}</span>
        <span style="color:var(--text-muted)">${escHtml(interim)}</span>
      </div>`;
  };

  recognition.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    console.warn('Speech recognition error:', e.error);
    if (e.error === 'not-allowed') {
      isRecording = false;
      if (recognition) { recognition.onend = null; recognition.stop(); }
      setFabRecording(false);
      document.getElementById('modalOverlay').classList.remove('show');
      alert('Microphone access denied.\nPlease allow microphone access in your browser settings and try again.');
      return;
    }
    document.getElementById('modalStatus').innerHTML = `
      <div style="color:var(--accent-rec); font-size:11px; padding:4px 0;">
        Recognition error: ${e.error}. Tap Stop and try again.
      </div>`;
  };

  recognition.onend = () => {
    if (isRecording) {
      setTimeout(() => {
        if (isRecording) {
          try { recognition.start(); } catch(err) { console.warn('Restart failed:', err); }
        }
      }, 150);
    }
  };

  recognition.start();
  document.getElementById('modalTitle').textContent = '// AUFNAHME LÄUFT';
  document.getElementById('modalOverlay').classList.add('show');
  setFabRecording(true);
}

function setFabRecording(on) {
  const fab = document.getElementById('fab');
  const micIcon  = document.getElementById('fabIcon');
  const stopIcon = document.getElementById('fabStopIcon');
  if (!fab) return;
  fab.classList.toggle('recording', on);
  if (micIcon)  micIcon.style.display  = on ? 'none'  : '';
  if (stopIcon) stopIcon.style.display = on ? ''      : 'none';
}

function stopRecording() {
  if (navigator.vibrate) navigator.vibrate([30, 50, 30]);
  isRecording = false;
  if (recognition) { recognition.onend = null; recognition.stop(); }

  setFabRecording(false);

  // Combine confirmed finals + any pending interim
  const transcript = (liveTranscript + ' ' + liveInterim).trim();
  liveInterim = '';

  if (!transcript) {
    document.getElementById('modalOverlay').classList.remove('show');
    return;
  }

  // Show review step — user can correct medical terms before saving
  document.getElementById('modalTitle').textContent = '// ÜBERPRÜFEN & KORRIGIEREN';
  document.getElementById('modalStatus').style.display = 'none';
  const ta = document.getElementById('reviewTextarea');
  ta.value = transcript;
  ta.style.display = 'block';
  document.getElementById('modalStopBtn').style.display = 'none';
  document.getElementById('modalConfirmBtn').style.display = 'flex';
}

function confirmAndProcess() {
  const transcript = document.getElementById('reviewTextarea').value.trim();

  // Reset modal to recording state for next time
  document.getElementById('modalStatus').style.display = 'block';
  document.getElementById('reviewTextarea').style.display = 'none';
  document.getElementById('modalStopBtn').style.display = 'flex';
  document.getElementById('modalConfirmBtn').style.display = 'none';

  if (!transcript) {
    document.getElementById('modalOverlay').classList.remove('show');
    return;
  }

  document.getElementById('modalTitle').textContent = '// VERARBEITUNG …';
  processTranscript(transcript);
}

// ───────────────────────────────────────────────
// MANUAL INPUT FALLBACK
// ───────────────────────────────────────────────
function showManualInput() {
  const text = prompt('Memo-Text eingeben:\n(Optional mit "Todo" oder "Aufgabe" beginnen)');
  if (text) processTranscript(text);
}

// Double-click empty entries area to trigger manual
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('entries').addEventListener('dblclick', (e) => {
    if (e.target === e.currentTarget) showManualInput();
  });
});

// ───────────────────────────────────────────────
// SAVE MEMO + AUTO-DOWNLOAD
// ───────────────────────────────────────────────
function saveCaptureAndDownload(kind, title, transcript) {
  const capture = {
    id: crypto.randomUUID(),
    kind,
    transcript,
    title,
    ts: Date.now(),
    updatedAt: Date.now(),
    source: 'pwa',
    done: false,
    dueDate: null,
    filed: false,
    ideaDocumentId: null,
    legacyPath: null,
  };
  captures.unshift(capture);
  saveCaptures();
  if (typeof Sync !== 'undefined') Sync.upsert(capture, 'captures');
  document.getElementById('modalOverlay').classList.remove('show');
  if (currentView === 'todos' || currentView === 'inbox') renderEntries();
}

// ───────────────────────────────────────────────
// PROCESS TRANSCRIPT — trigger-word split, to-do vs. idea (VISION.md)
// ───────────────────────────────────────────────
const TODO_TRIGGERS = { 'todo': true, 'aufgabe': true };

function processTranscript(transcript) {
  const t = transcript.trim();

  let kind = 'idea';
  let cleanText = t;

  const firstWord = t.split(/[\s,.:;!?]+/)[0].toLowerCase().replace(/[^a-z0-9äöüß]/g, '');

  if (TODO_TRIGGERS[firstWord]) {
    kind = 'todo';
    const rest = t.slice(firstWord.length).replace(/^[\s,.:;]+/, '');
    cleanText = rest || t;
  }

  runTitleAndSaveCapture(kind, cleanText);
}

function runTitleAndSaveCapture(kind, cleanText) {
  document.getElementById('modalStatus').style.display = 'block';
  document.getElementById('modalStatus').innerHTML = `
    <div class="processing">
      <div class="spinner"></div>
      Titel wird generiert …
    </div>`;

  generateTitle(cleanText, kind).then(title => {
    saveCaptureAndDownload(kind, title, cleanText);
  }).catch(() => {
    const words = cleanText.split(' ');
    const title = words.slice(0,6).join(' ') + (words.length > 6 ? '…' : '');
    saveCaptureAndDownload(kind, title, cleanText);
  });
}

// ───────────────────────────────────────────────
// AI TITLE GENERATION
// ───────────────────────────────────────────────
async function generateTitle(text, kind) {
  const kindLabel = kind === 'todo' ? 'To-Do' : 'Idee';
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `You are a title generator for a voice-captured "${kindLabel}".\n\nGiven this text, generate a SHORT, SPECIFIC, DESCRIPTIVE title (4-8 words max). Be concise and informative. Return ONLY the title text, nothing else.\n\nText:\n${text.substring(0, 800)}`
      }]
    })
  });

  const data = await response.json();
  const raw = data.content?.[0]?.text?.trim() || '';
  // strip quotes if present
  return raw.replace(/^["']|["']$/g, '').trim() || text.split(' ').slice(0,6).join(' ');
}

// ───────────────────────────────────────────────
// ONE-TIME MIGRATION — voice_memos (old 5-path model) → captures (todo/idea)
// See PLAN V2, V2-P2. voice_memos is kept, untouched, as a safety net — this
// only ever reads from it, never writes or deletes. The memo_schema_v3 flag
// is a fast-path (skip the whole function once this browser has already
// migrated) — but it's per-browser localStorage, so a second device or a
// fresh/incognito session has no flag and would re-run this. The per-item
// `captures.some(...)` check below is what actually makes this idempotent
// across devices: captures[] was just populated by Sync.pull() from
// Supabase (the shared source of truth), so an item already migrated on any
// device is already present there and gets skipped — without this check, a
// re-run would stomp newer captures-side edits (e.g. a done-toggle made via
// the to-do list) with stale data reconstructed from voice_memos.
// ───────────────────────────────────────────────
async function migrateLegacyMemosToCaptures() {
  if (localStorage.getItem('memo_schema_v3')) return;
  if (!memos.length) { localStorage.setItem('memo_schema_v3', '1'); return; }

  for (const memo of memos) {
    if (captures.some(c => c.id === memo.id)) continue;
    const kind = memo.path === 'E' ? 'todo' : 'idea';
    const capture = {
      id: memo.id,
      kind,
      transcript: memo.text || '',
      title: memo.title || '',
      ts: memo.ts,
      updatedAt: Date.now(),
      source: memo.source || 'mac',
      done: kind === 'todo' ? !!memo.done : false,
      dueDate: null,
      filed: false,
      ideaDocumentId: null,
      legacyPath: kind === 'idea' ? memo.path : null,
    };
    captures.unshift(capture);
    if (typeof Sync !== 'undefined') await Sync.upsert(capture, 'captures');
  }
  saveCaptures();
  localStorage.setItem('memo_schema_v3', '1');
  console.log(`Migrated ${memos.length} legacy memo(s) into captures.`);
}

// ───────────────────────────────────────────────
// AUTH — Supabase Auth (email + password). Only gates sync, never plain
// local use: if config.js is missing entirely, the app skips auth and works
// local-only exactly as before (see Sync.getSession()/ensureClient()).
// ───────────────────────────────────────────────
async function login(e) {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  if (!email || !password) return;
  const btn = document.getElementById('loginSubmitBtn');
  const status = document.getElementById('loginStatus');
  btn.disabled = true;
  status.textContent = 'Melde an …';
  try {
    await Sync.signInWithPassword(email, password);
    onLoggedIn();
  } catch (err) {
    status.textContent = 'Fehler: ' + (err.message || err);
    btn.disabled = false;
  }
}

function logout() {
  if (typeof Sync !== 'undefined') Sync.signOut();
}

// Called both directly from login()'s success path and from bootApp()'s
// SIGNED_IN listener (e.g. on a page load that already has a session) — the
// guard makes it safe to fire from both without double-subscribing.
let _loggedInHandled = false;
function onLoggedIn() {
  if (_loggedInHandled) return;
  _loggedInHandled = true;
  document.getElementById('loginOverlay').classList.remove('show');
  document.getElementById('logoutBtn').style.display = '';
  Sync.init();
  Sync.pull().then(migrateLegacyMemosToCaptures);
}

async function bootApp() {
  renderEntries();
  if (typeof Sync === 'undefined') return;

  Sync.onAuthChange((event, session) => {
    if (event === 'SIGNED_IN' && session) onLoggedIn();
    else if (event === 'SIGNED_OUT') location.reload();
  });

  const session = await Sync.getSession();
  if (session) {
    onLoggedIn();
  } else if (typeof SUPABASE_URL !== 'undefined') {
    // Supabase is configured but nobody's logged in — block sync until they are.
    document.getElementById('loginOverlay').classList.add('show');
  }
}

// ───────────────────────────────────────────────
// INIT
// ───────────────────────────────────────────────
bootApp();

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && typeof Sync !== 'undefined') {
    Sync.resubscribe();
    Sync.pull();
  }
});

// ───────────────────────────────────────────────
// EDITOR
// ───────────────────────────────────────────────
function openEditor(id, event) {
  if (event) event.stopPropagation();
  const memo = memos.find(m => m.id === id);
  if (!memo) return;
  editorId = id;
  editorMode = 'memo';
  document.getElementById('editorNavTitle').textContent = '// MEMO BEARBEITEN';

  // Title
  document.getElementById('editorTitle').textContent = memo.title;

  // Body — prefer stored HTML, else convert plain text
  const contentEl = document.getElementById('editorContent');
  contentEl.innerHTML = memo.html || escHtml(memo.text).replace(/\n/g, '<br>');
  contentEl.style.fontFamily = memo.editorFont || '';
  contentEl.style.fontSize   = memo.editorSize ? memo.editorSize + 'px' : '';

  // Font controls
  document.getElementById('fontFamilySelect').value = memo.editorFont || '-apple-system, BlinkMacSystemFont, sans-serif';
  document.getElementById('fontSizeSelect').value   = memo.editorSize || 15;

  // Path tag
  const tagEl = document.getElementById('editorPathTag');
  if (['A','B','C','D','E'].includes(memo.path)) {
    tagEl.className = 'editor-path-tag tag-' + memo.path.toLowerCase();
    tagEl.removeAttribute('style');
  } else {
    const ec = getPathColor(memo.path);
    tagEl.className = 'editor-path-tag';
    tagEl.style.cssText = `color:${ec};`;
  }
  tagEl.textContent = getPathName(memo.path).toUpperCase();

  // LLM prompt
  const cat = getPathName(memo.path);
  const dateStr = new Date(memo.ts).toLocaleDateString('de-DE', {day:'2-digit', month:'long', year:'numeric'});
  document.getElementById('llmPrompt').value =
    `Kategorie: ${cat}\nDatum: ${dateStr}\n\nMeine Notiz:\n${memo.text}\n\n---\nMeine Frage / Aufgabe an dich:\n`;

  document.getElementById('editorOverlay').classList.add('show');
}

function closeEditor() {
  document.getElementById('editorOverlay').classList.remove('show');
  editorId = null;
}

function saveEditor() {
  if (!editorId) return;

  if (editorMode === 'idea') {
    const doc = ideaDocuments.find(d => d.id === editorId);
    if (!doc) return;
    const contentEl = document.getElementById('editorContent');
    doc.title     = document.getElementById('editorTitle').textContent.trim() || doc.title;
    doc.html      = contentEl.innerHTML;
    doc.updatedAt = Date.now();
    saveIdeaDocuments();
    if (typeof Sync !== 'undefined') Sync.upsert(doc, 'idea_documents');
    if (currentView === 'docs') renderEntries();
    closeEditor();
    return;
  }

  const memo = memos.find(m => m.id === editorId);
  if (!memo) return;

  const contentEl = document.getElementById('editorContent');
  memo.title      = document.getElementById('editorTitle').textContent.trim() || memo.title;
  memo.html       = contentEl.innerHTML;
  memo.text       = contentEl.innerText;
  memo.editorFont = document.getElementById('fontFamilySelect').value;
  memo.editorSize = parseInt(document.getElementById('fontSizeSelect').value);
  memo.updatedAt  = Date.now();

  saveMemos();
  if (typeof Sync !== 'undefined') Sync.upsert(memo);
  renderEntries();
  closeEditor();
}

// ───────────────────────────────────────────────
// IDEA DOCUMENTS — inbox items get filed into these (V2-P5)
// ───────────────────────────────────────────────
// Awaits the remote write before returning — callers that immediately create
// a captures row with a foreign key to this document (fileIntoNewDocument())
// depend on the document existing server-side first, or Postgrest 409s on
// the FK. Sync.upsert() resolves either after a successful write or after
// queuing to the outbox, so this is safe offline too.
async function makeIdeaDocument(title) {
  const doc = {
    id: crypto.randomUUID(),
    title,
    html: '',
    canvas: { nodes: [], edges: [] },
    viewport: null,
    ts: Date.now(),
    updatedAt: Date.now(),
  };
  ideaDocuments.unshift(doc);
  saveIdeaDocuments();
  if (typeof Sync !== 'undefined') await Sync.upsert(doc, 'idea_documents');
  return doc;
}

async function createIdeaDocument() {
  const title = prompt('Titel für das neue Dokument:');
  if (!title) return;
  const doc = await makeIdeaDocument(title.trim());
  if (currentView === 'docs') renderEntries();
  openIdeaEditor(doc.id);
}

function openIdeaEditor(id) {
  const doc = ideaDocuments.find(d => d.id === id);
  if (!doc) return;
  editorId = id;
  editorMode = 'idea';
  document.getElementById('editorNavTitle').textContent = '// DOKUMENT BEARBEITEN';

  document.getElementById('editorTitle').textContent = doc.title;

  const contentEl = document.getElementById('editorContent');
  contentEl.innerHTML = doc.html || '';
  contentEl.style.fontFamily = '';
  contentEl.style.fontSize = '';

  document.getElementById('fontFamilySelect').value = '-apple-system, BlinkMacSystemFont, sans-serif';
  document.getElementById('fontSizeSelect').value = 15;

  const tagEl = document.getElementById('editorPathTag');
  tagEl.className = 'editor-path-tag';
  tagEl.style.cssText = 'color:var(--text-muted);';
  tagEl.textContent = 'IDEE';

  const dateStr = new Date(doc.ts).toLocaleDateString('de-DE', {day:'2-digit', month:'long', year:'numeric'});
  document.getElementById('llmPrompt').value =
    `Dokument: ${doc.title}\nErstellt: ${dateStr}\n\nInhalt:\n${stripHtml(doc.html)}\n\n---\nMeine Frage / Aufgabe an dich:\n`;

  document.getElementById('editorOverlay').classList.add('show');
}

// ───────────────────────────────────────────────
// MERGE PICKER — file an inbox idea into a document (V2-P5)
// ───────────────────────────────────────────────
let _mergeCaptureId = null;

function openMergePicker(captureId, e) {
  if (e) e.stopPropagation();
  _mergeCaptureId = captureId;

  const list = document.getElementById('mergeDocList');
  if (!ideaDocuments.length) {
    list.innerHTML = `<p style="font-family:var(--mono); font-size:10px; color:var(--text-muted);">Noch keine Dokumente — erstelle unten ein neues.</p>`;
  } else {
    list.innerHTML = ideaDocuments.map(d =>
      `<button class="merge-doc-btn" onclick="fileIntoDocument('${d.id}')">${escHtml(d.title)}</button>`
    ).join('');
  }

  document.getElementById('mergeNewTitle').value = '';
  // The detail overlay (z-index 200) sits above the modal overlay (z-index
  // 100) — hide it first or the picker renders fully occluded/unclickable.
  document.getElementById('detailOverlay').classList.remove('show');
  document.getElementById('mergePickerOverlay').classList.add('show');
}

// Cancel path only — fileIntoDocument() below handles its own success path
// (it always navigates away rather than restoring the detail overlay).
function closeMergePicker() {
  document.getElementById('mergePickerOverlay').classList.remove('show');
  _mergeCaptureId = null;
  if (location.hash.startsWith('#capture/')) {
    document.getElementById('detailOverlay').classList.add('show');
  }
}

function fileIntoDocument(docId) {
  if (!_mergeCaptureId) return;
  const c = captures.find(x => x.id === _mergeCaptureId);
  if (!c) { closeMergePicker(); return; }

  // Filing only marked the capture `filed` — it never actually copied the
  // idea's content anywhere, so the document stayed empty. Append it as a
  // section so opening the document shows what was filed into it. Canvas
  // (V2-P6) will eventually give ideas a proper transcript node instead of
  // this being appended as plain HTML.
  const doc = ideaDocuments.find(d => d.id === docId);
  if (doc) {
    const block = `<p><strong>${escHtml(c.title || '')}</strong></p><p>${escHtml(c.transcript).replace(/\n/g, '<br>')}</p><hr>`;
    doc.html = (doc.html || '') + block;
    doc.updatedAt = Date.now();
    saveIdeaDocuments();
    if (typeof Sync !== 'undefined') Sync.upsert(doc, 'idea_documents');
  }

  c.filed = true;
  c.ideaDocumentId = docId;
  c.updatedAt = Date.now();
  saveCaptures();
  if (typeof Sync !== 'undefined') Sync.upsert(c, 'captures');

  document.getElementById('mergePickerOverlay').classList.remove('show');
  _mergeCaptureId = null;
  renderEntries();
  navigateBack();
}

async function fileIntoNewDocument() {
  const title = document.getElementById('mergeNewTitle').value.trim();
  if (!title) { alert('Bitte einen Titel eingeben.'); return; }
  const doc = await makeIdeaDocument(title);
  fileIntoDocument(doc.id);
}

function applyFontFamily(value) {
  document.getElementById('editorContent').style.fontFamily = value;
}

function applyFontSize(value) {
  document.getElementById('editorContent').style.fontSize = value + 'px';
}

function insertEditorTable() {
  const tableHTML = `<br><table>
    <thead><tr><th>Spalte 1</th><th>Spalte 2</th><th>Spalte 3</th></tr></thead>
    <tbody>
      <tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>
      <tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>
      <tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>
    </tbody>
  </table><br>`;
  const contentEl = document.getElementById('editorContent');
  contentEl.focus();
  const sel = window.getSelection();
  if (sel.rangeCount) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const tmp = document.createElement('div');
    tmp.innerHTML = tableHTML;
    const frag = document.createDocumentFragment();
    while (tmp.firstChild) frag.appendChild(tmp.firstChild);
    range.insertNode(frag);
  } else {
    contentEl.innerHTML += tableHTML;
  }
}

function copyLLMPrompt() {
  const val = document.getElementById('llmPrompt').value;
  navigator.clipboard.writeText(val).then(() => {
    const btn = document.querySelector('.llm-copy-btn');
    const orig = btn.textContent;
    btn.textContent = '✓ Kopiert';
    btn.classList.add('llm-copy-btn--done');
    setTimeout(() => {
      btn.textContent = orig;
      btn.classList.remove('llm-copy-btn--done');
    }, 2000);
  });
}

function openLLMPrompt() {
  document.getElementById('llmPromptOverlay').classList.add('show');
}

function closeLLMPrompt() {
  document.getElementById('llmPromptOverlay').classList.remove('show');
}

// ───────────────────────────────────────────────
// ROUTING — hash-based
// ───────────────────────────────────────────────
function navigateToDetail(id) {
  location.hash = 'memo/' + id;
}

function navigateToCaptureDetail(id) {
  location.hash = 'capture/' + id;
}

function navigateBack() {
  location.hash = '';
}

function handleRoute() {
  const hash = location.hash.replace(/^#/, '');
  if (hash.startsWith('memo/')) {
    showDetail(hash.slice(5));
  } else if (hash.startsWith('capture/')) {
    showCaptureDetail(hash.slice(8));
  } else {
    hideDetail();
  }
}

function showDetail(id) {
  const memo = memos.find(m => m.id === id);
  if (!memo) { navigateBack(); return; }

  if (memo.isNew) {
    memo.isNew = false;
    saveMemos();
    renderEntries();
  }

  const dt = new Date(memo.ts);
  const dateStr = dt.toLocaleDateString('en-GB', {weekday:'long', year:'numeric', month:'long', day:'numeric'});
  const timeStr = dt.toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'});

  const navPath = document.getElementById('detailNavPath');
  applyPathTagStyle(navPath, memo.path);

  document.getElementById('detailTimestamp').textContent = dateStr + ' · ' + timeStr;
  document.getElementById('detailTitle').textContent = memo.title;

  const checkboxEl = document.getElementById('detailCheckbox');
  if (memo.path === 'E') {
    checkboxEl.style.display = '';
    checkboxEl.classList.toggle('checked', !!memo.done);
    checkboxEl.onclick = () => toggleMemoDone(id, null);
  } else {
    checkboxEl.style.display = 'none';
  }
  document.getElementById('detailTitle').classList.toggle('is-done', memo.path === 'E' && !!memo.done);

  const textEl = document.getElementById('detailText');
  if (memo.html) {
    textEl.innerHTML = memo.html;
    textEl.className = 'detail-text detail-text--html';
  } else {
    textEl.textContent = memo.text;
    textEl.className = 'detail-text';
  }

  document.getElementById('detailEditBtn').style.display = '';
  document.getElementById('detailEditBtn').onclick     = () => openEditor(id, null);
  document.getElementById('detailCopyBtn').onclick     = () => copyMemo(id, null);
  document.getElementById('detailDownloadBtn').onclick = () => downloadMemo(id, null);
  document.getElementById('detailDeleteBtn').onclick   = () => deleteMemo(id, null);
  document.getElementById('detailFileBtn').style.display = 'none';

  document.getElementById('detailOverlay').classList.add('show');
}

function applyCaptureTagStyle(el, kind) {
  const dot = `<span style="width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block"></span>`;
  const label = kind === 'todo' ? 'TO-DO' : 'IDEE';
  if (kind === 'todo') {
    el.className = 'entry-path-tag tag-e';
    el.removeAttribute('style');
  } else {
    el.className = 'entry-path-tag';
    el.style.cssText = 'color:var(--text-muted);';
  }
  el.innerHTML = dot + label;
}

function showCaptureDetail(id) {
  const c = captures.find(x => x.id === id);
  if (!c) { navigateBack(); return; }

  const dt = new Date(c.ts);
  const dateStr = dt.toLocaleDateString('en-GB', {weekday:'long', year:'numeric', month:'long', day:'numeric'});
  const timeStr = dt.toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'});

  applyCaptureTagStyle(document.getElementById('detailNavPath'), c.kind);

  document.getElementById('detailTimestamp').textContent = dateStr + ' · ' + timeStr;
  document.getElementById('detailTitle').textContent = c.title || c.transcript.slice(0, 60);

  const checkboxEl = document.getElementById('detailCheckbox');
  if (c.kind === 'todo') {
    checkboxEl.style.display = '';
    checkboxEl.classList.toggle('checked', !!c.done);
    checkboxEl.onclick = () => toggleCaptureDone(id, null);
  } else {
    checkboxEl.style.display = 'none';
  }
  document.getElementById('detailTitle').classList.toggle('is-done', c.kind === 'todo' && !!c.done);

  const textEl = document.getElementById('detailText');
  textEl.textContent = c.transcript;
  textEl.className = 'detail-text';

  document.getElementById('detailEditBtn').style.display = 'none';
  document.getElementById('detailCopyBtn').onclick     = () => copyCapture(id, null);
  document.getElementById('detailDownloadBtn').onclick = () => downloadCapture(id, null);
  document.getElementById('detailDeleteBtn').onclick   = () => deleteCapture(id, null);

  const fileBtn = document.getElementById('detailFileBtn');
  if (c.kind === 'idea' && !c.filed) {
    fileBtn.style.display = '';
    fileBtn.onclick = () => openMergePicker(id, null);
  } else {
    fileBtn.style.display = 'none';
  }

  document.getElementById('detailOverlay').classList.add('show');
}

function hideDetail() {
  document.getElementById('detailOverlay').classList.remove('show');
}

window.addEventListener('hashchange', handleRoute);
handleRoute();
