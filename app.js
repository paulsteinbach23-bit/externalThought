// ───────────────────────────────────────────────
// THEME
// ───────────────────────────────────────────────
const THEME_COLORS = { dark: '#0c1a0e', light: '#f5f2e2' };

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.getElementById('themeColorMeta');
  if (meta) meta.content = THEME_COLORS[theme] || THEME_COLORS.dark;
}

function initTheme() {
  applyTheme(localStorage.getItem('memo_theme') || 'dark');
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
const CUSTOM_PATH_COLORS = ['#e07040', '#9b6bc4', '#3a9bc4', '#c43a8a', '#3ac4b8'];

let memos = JSON.parse(localStorage.getItem('voice_memos') || '[]');
let customPaths = JSON.parse(localStorage.getItem('voice_paths') || '[]');
let currentFilter = 'all';
let sortOrder = 'newest';
let editorId = null;
let _recordPreselectedPath = null;
let mediaRecorder = null;
let audioChunks = [];
let recognition = null;
let isRecording = false;
let liveTranscript = '';
let liveInterim = '';

function saveMemos() {
  localStorage.setItem('voice_memos', JSON.stringify(memos));
}

function saveCustomPaths() {
  localStorage.setItem('voice_paths', JSON.stringify(customPaths));
}

// ── PATH HELPERS ──────────────────────────────
function getPathName(id) {
  if (id === 'A') return 'Work';
  if (id === 'B') return 'Research';
  if (id === 'C') return 'Business Ideas';
  return (customPaths.find(p => p.id === id) || {}).name || id;
}

function getPathColor(id) {
  if (id === 'A') return 'var(--accent-a)';
  if (id === 'B') return 'var(--accent-b)';
  if (id === 'C') return 'var(--accent-c)';
  const cp = customPaths.find(p => p.id === id);
  return cp ? CUSTOM_PATH_COLORS[cp.colorIdx % CUSTOM_PATH_COLORS.length] : '#888';
}

// Returns the entry-path-tag HTML for a given path id
function pathTagHtml(id) {
  const dot = `<span style="width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block"></span>`;
  const name = escHtml(getPathName(id).toUpperCase());
  if (['A','B','C'].includes(id)) {
    return `<div class="entry-path-tag tag-${id.toLowerCase()}">${dot}${name}</div>`;
  }
  const color = getPathColor(id);
  return `<div class="entry-path-tag" style="background:${color}20;color:${color};">${dot}${name}</div>`;
}

// Applies path-tag styles to an existing DOM element
function applyPathTagStyle(el, id) {
  const dot = `<span style="width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block"></span>`;
  const name = escHtml(getPathName(id).toUpperCase());
  if (['A','B','C'].includes(id)) {
    el.className = (el.className.replace(/\btag-[a-c]\b|\bcustom-tag\b/g, '').trim()) + ' tag-' + id.toLowerCase();
    el.removeAttribute('style');
  } else {
    const color = getPathColor(id);
    el.className = el.className.replace(/\btag-[a-c]\b/g, '').trim();
    el.style.cssText = `background:${color}20; color:${color};`;
  }
  el.innerHTML = dot + name;
}

// ───────────────────────────────────────────────
// CLOCK
// ───────────────────────────────────────────────
function updateClock() {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString('en-GB', {hour12:false});
}
setInterval(updateClock, 1000);
updateClock();

// ───────────────────────────────────────────────
// FILTER
// ───────────────────────────────────────────────

function setFilter(f, btn) {
  currentFilter = f;
  // Sync sidebar, legacy mobile filter, and category tabs
  document.querySelectorAll('.path-btn, .mobile-filter-btn, .cat-tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll(`[data-filter="${f}"]`).forEach(b => b.classList.add('active'));
  const titleEl = document.getElementById('mainTitle');
  if (f === 'all') {
    titleEl.innerHTML = '<span class="badge" style="background:var(--text-muted)"></span>ALLE MEMOS';
  } else {
    titleEl.innerHTML = `<span class="badge" style="background:${getPathColor(f)}"></span>${escHtml(getPathName(f).toUpperCase())}`;
  }
  // Close sidebar on mobile after filter selection
  const sidebar = document.getElementById('sidebar');
  if (sidebar && sidebar.classList.contains('open')) toggleSidebar();
  renderEntries();
}

// ───────────────────────────────────────────────
// RENDER
// ───────────────────────────────────────────────
function renderEntries() {
  const container = document.getElementById('entries');
  const search = document.getElementById('searchInput').value.toLowerCase();

  let filtered = memos.filter(m => {
    if (currentFilter !== 'all' && m.path !== currentFilter) return false;
    if (search && !m.title.toLowerCase().includes(search) && !m.text.toLowerCase().includes(search)) return false;
    return true;
  });

  filtered.sort((a,b) => sortOrder === 'newest' ? b.ts - a.ts : a.ts - b.ts);

  // update counts
  document.getElementById('count-all').textContent = memos.length;
  document.getElementById('count-a').textContent = memos.filter(m=>m.path==='A').length;
  document.getElementById('count-b').textContent = memos.filter(m=>m.path==='B').length;
  document.getElementById('count-c').textContent = memos.filter(m=>m.path==='C').length;
  customPaths.forEach(cp => {
    const el = document.getElementById('count-' + cp.id);
    if (el) el.textContent = memos.filter(m=>m.path===cp.id).length;
  });
  document.getElementById('stat-total').textContent = memos.length;
  document.getElementById('stat-a').textContent = memos.filter(m=>m.path==='A').length;
  document.getElementById('stat-b').textContent = memos.filter(m=>m.path==='B').length;
  document.getElementById('stat-c').textContent = memos.filter(m=>m.path==='C').length;

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">◎</div>
        <p>NO MEMOS FOUND</p>
        <p style="font-size:10px; opacity:0.5;">Record your first memo →</p>
      </div>`;
    return;
  }

  // Group by date
  const groups = {};
  filtered.forEach(m => {
    const d = new Date(m.ts);
    const key = d.toLocaleDateString('en-GB', {weekday:'long', year:'numeric', month:'long', day:'numeric'});
    if (!groups[key]) groups[key] = [];
    groups[key].push(m);
  });

  let html = '';
  for (const [date, items] of Object.entries(groups)) {
    html += `<div class="date-group-label">${date}</div>`;
    items.forEach(m => {
      const time = new Date(m.ts).toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'});
      html += `
        <div class="entry-card${m.isNew?' is-new':''}" onclick="navigateToDetail('${m.id}')">
          <div>
            ${pathTagHtml(m.path)}
            <div class="entry-title">${highlight(m.title, search)}</div>
            <div class="entry-preview">${highlight(m.text.substring(0,140), search)}${m.text.length>140?'…':''}</div>
          </div>
          <div class="entry-meta">${time}</div>
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
  renderEntries();
  if (location.hash === '#memo/' + id) navigateBack();
}

function sanitizeFilename(str) {
  return str.replace(/[^a-z0-9_\-\s]/gi,'').replace(/\s+/g,'_').toLowerCase().substring(0,60);
}

// ───────────────────────────────────────────────
// FAB — path-first recording flow
// ───────────────────────────────────────────────
function onFabClick() {
  if (isRecording) stopRecording();
  else openRecordPathPicker();
}

function openRecordPathPicker() {
  document.getElementById('recordPathOverlay').classList.add('show');
}

function pickRecordPath(path) {
  document.getElementById('recordPathOverlay').classList.remove('show');
  if (!path) return;
  _recordPreselectedPath = path;
  startRecording();
}

// ───────────────────────────────────────────────
// RECORDING — Web Speech API
// ───────────────────────────────────────────────
function startRecording() {
  if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
    alert('Your browser does not support the Web Speech API.\nPlease use Chrome or Edge for voice recording.\n\nAlternatively, you can type your memo below using the manual input (double-click any empty area).');
    _recordPreselectedPath = null;
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
      _recordPreselectedPath = null;
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
  const text = prompt('Memo-Text eingeben:\n(Beginne mit "A:", "B:" oder "C:")');
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
function saveMemoAndDownload(path, title, text) {
  const memo = {
    id: 'memo_' + Date.now(),
    path,
    title,
    text,
    ts: Date.now(),
    isNew: true
  };
  memos.unshift(memo);
  saveMemos();
  document.getElementById('modalOverlay').classList.remove('show');
  renderEntries();
  location.hash = 'memo/' + memo.id;
}

// ───────────────────────────────────────────────
// PROCESS TRANSCRIPT
// ───────────────────────────────────────────────
const KEYWORD_MAP = {
  'a': 'A', 'anton': 'A', 'alpha': 'A', 'eins': 'A', '1': 'A',
  'b': 'B', 'berta': 'B', 'bruno': 'B', 'bravo': 'B', 'beta': 'B', 'zwei': 'B', '2': 'B',
  'c': 'C', 'cäsar': 'C', 'casar': 'C', 'caesar': 'C', 'clara': 'C', 'charlie': 'C', 'drei': 'C', '3': 'C',
};

function processTranscript(transcript) {
  const t = transcript.trim();

  // Path was pre-selected via FAB overlay — skip keyword detection
  if (_recordPreselectedPath) {
    const path = _recordPreselectedPath;
    _recordPreselectedPath = null;
    runTitleAndSave(path, t);
    return;
  }

  let path = null;
  let cleanText = t;

  const firstWord = t.split(/[\s,.:;!?]+/)[0].toLowerCase().replace(/[^a-z0-9äöüß]/g, '');

  // Check default keyword map
  if (KEYWORD_MAP[firstWord]) {
    path = KEYWORD_MAP[firstWord];
    const rest = t.slice(firstWord.length).replace(/^[\s,.:;]+/, '');
    cleanText = rest || t;
  }

  // Check custom path names — first word of each name (case-insensitive)
  if (!path) {
    for (const cp of customPaths) {
      const cpFirst = cp.name.split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9äöüß]/g, '');
      if (cpFirst && firstWord === cpFirst) {
        path = cp.id;
        const rest = t.slice(cp.name.split(/\s+/)[0].length).replace(/^[\s,.:;]+/, '');
        cleanText = rest || t;
        break;
      }
    }
  }

  if (!path) {
    showPathPicker(t, t);
    return;
  }

  runTitleAndSave(path, cleanText);
}

// Styled path picker instead of native prompt()
let _pendingTranscript = null;

function showPathPicker(previewText, fullTranscript) {
  _pendingTranscript = fullTranscript;
  const hint = previewText.length > 72 ? previewText.substring(0, 72) + '…' : previewText;
  document.getElementById('pathPickerHint').textContent = `„${hint}"`;
  document.getElementById('pathPickerOverlay').classList.add('show');
}

function pickPath(path) {
  document.getElementById('pathPickerOverlay').classList.remove('show');
  if (!path || !_pendingTranscript) {
    document.getElementById('modalOverlay').classList.remove('show');
    _pendingTranscript = null;
    return;
  }
  const transcript = _pendingTranscript;
  _pendingTranscript = null;
  runTitleAndSave(path, transcript);
}

function runTitleAndSave(path, cleanText) {
  document.getElementById('modalStatus').style.display = 'block';
  document.getElementById('modalStatus').innerHTML = `
    <div class="processing">
      <div class="spinner"></div>
      Titel wird generiert …
    </div>`;

  generateTitle(cleanText, path).then(title => {
    saveMemoAndDownload(path, title, cleanText);
  }).catch(() => {
    const words = cleanText.split(' ');
    const title = words.slice(0,6).join(' ') + (words.length > 6 ? '…' : '');
    saveMemoAndDownload(path, title, cleanText);
  });
}

// ───────────────────────────────────────────────
// AI TITLE GENERATION
// ───────────────────────────────────────────────
async function generateTitle(text, path) {
  const categoryName = getPathName(path);
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `You are a title generator for voice memos in the "${categoryName}" category.\n\nGiven this voice memo text, generate a SHORT, SPECIFIC, DESCRIPTIVE title (4-8 words max). Be concise and informative. Return ONLY the title text, nothing else.\n\nMemo text:\n${text.substring(0, 800)}`
      }]
    })
  });

  const data = await response.json();
  const raw = data.content?.[0]?.text?.trim() || '';
  // strip quotes if present
  return raw.replace(/^["']|["']$/g, '').trim() || text.split(' ').slice(0,6).join(' ');
}

// ───────────────────────────────────────────────
// INIT
// ───────────────────────────────────────────────
renderEntries();
renderDynamicUI();

// ───────────────────────────────────────────────
// EDITOR
// ───────────────────────────────────────────────
function openEditor(id, event) {
  if (event) event.stopPropagation();
  const memo = memos.find(m => m.id === id);
  if (!memo) return;
  editorId = id;

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
  if (['A','B','C'].includes(memo.path)) {
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
  const memo = memos.find(m => m.id === editorId);
  if (!memo) return;

  const contentEl = document.getElementById('editorContent');
  memo.title      = document.getElementById('editorTitle').textContent.trim() || memo.title;
  memo.html       = contentEl.innerHTML;
  memo.text       = contentEl.innerText;
  memo.editorFont = document.getElementById('fontFamilySelect').value;
  memo.editorSize = parseInt(document.getElementById('fontSizeSelect').value);

  saveMemos();
  renderEntries();
  closeEditor();
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

function toggleSidebar() {
  const sidebar  = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebarBackdrop');
  const isOpen   = sidebar.classList.toggle('open');
  backdrop.classList.toggle('show', isOpen);
}

// ───────────────────────────────────────────────
// CUSTOM PATHS
// ───────────────────────────────────────────────
function renderDynamicUI() {
  const dot = (color) => `<span class="path-dot" style="background:${color};"></span>`;

  // Sidebar
  const customList = document.getElementById('customPathList');
  if (customList) {
    customList.innerHTML = customPaths.map(cp => {
      const color = getPathColor(cp.id);
      const count = memos.filter(m=>m.path===cp.id).length;
      const isActive = currentFilter === cp.id ? ' active' : '';
      return `
        <div class="custom-path-row" id="cpr-${cp.id}">
          <button class="path-btn custom-path-btn${isActive}" data-filter="${cp.id}"
            style="--cp-color:${color}" onclick="setFilter('${cp.id}', this)">
            ${dot(color)}${escHtml(cp.name)}<span class="path-count" id="count-${cp.id}">${count}</span>
          </button>
          <button class="custom-path-delete" onclick="deleteCustomPath('${cp.id}')" title="Löschen">×</button>
        </div>`;
    }).join('');
  }

  // Category tabs
  const customCatTabs = document.getElementById('customCatTabs');
  if (customCatTabs) {
    customCatTabs.innerHTML = customPaths.map(cp => {
      const color = getPathColor(cp.id);
      const isActive = currentFilter === cp.id ? ' active' : '';
      return `<button class="cat-tab custom-cat-tab${isActive}" data-filter="${cp.id}"
        style="--cp-color:${color}" onclick="setFilter('${cp.id}', this)">
        ${dot(color)}${escHtml(cp.name)}</button>`;
    }).join('');
  }

  // Pre-recording overlay
  const customRecordPaths = document.getElementById('customRecordPaths');
  if (customRecordPaths) {
    customRecordPaths.innerHTML = customPaths.map(cp => {
      const color = getPathColor(cp.id);
      const abbr = escHtml(cp.name.substring(0,2).toUpperCase());
      return `<button class="record-path-btn" onclick="pickRecordPath('${cp.id}')"
        style="color:${color}; border-color:${color}40; flex:0 0 auto; min-height:80px;">
        <span class="rp-letter" style="font-size:22px;">${abbr}</span>
        <span class="rp-label">${escHtml(cp.name)}</span>
      </button>`;
    }).join('');
  }

  // Fallback path picker modal
  const customPickerPaths = document.getElementById('customPickerPaths');
  if (customPickerPaths) {
    customPickerPaths.innerHTML = customPaths.map(cp => {
      const color = getPathColor(cp.id);
      return `<button class="path-picker-option" onclick="pickPath('${cp.id}')">
        <span class="path-dot" style="background:${color};"></span>
        <span class="path-picker-label">${escHtml(cp.name)}</span>
      </button>`;
    }).join('');
  }
}

function openNewPathModal() {
  document.getElementById('newPathInput').value = '';
  document.getElementById('newPathError').textContent = '';
  updateNewPathPreview('');
  document.getElementById('newPathOverlay').classList.add('show');
  setTimeout(() => document.getElementById('newPathInput').focus(), 60);
}

function closeNewPathModal() {
  document.getElementById('newPathOverlay').classList.remove('show');
}

function updateNewPathPreview(name) {
  const preview = document.getElementById('newPathPreview');
  if (!preview) return;
  if (!name.trim()) { preview.innerHTML = ''; return; }
  const idx = customPaths.length % CUSTOM_PATH_COLORS.length;
  const color = CUSTOM_PATH_COLORS[idx];
  preview.innerHTML = `<div class="entry-path-tag" style="background:${color}20;color:${color};">
    <span style="width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block;margin-right:5px;"></span>
    ${escHtml(name.toUpperCase())}
  </div>`;
}

function saveNewPath() {
  const name = document.getElementById('newPathInput').value.trim();
  const errEl = document.getElementById('newPathError');
  if (!name) { errEl.textContent = 'Bitte einen Namen eingeben.'; return; }
  if (name.length > 40) { errEl.textContent = 'Max. 40 Zeichen.'; return; }
  if (customPaths.some(p => p.name.toLowerCase() === name.toLowerCase())) {
    errEl.textContent = 'Pfad mit diesem Namen existiert bereits.'; return;
  }
  const colorIdx = customPaths.length % CUSTOM_PATH_COLORS.length;
  const id = 'cp_' + Date.now();
  customPaths.push({ id, name, colorIdx });
  saveCustomPaths();
  renderDynamicUI();
  closeNewPathModal();
}

function deleteCustomPath(id) {
  const count = memos.filter(m => m.path === id).length;
  if (count > 0) {
    const row = document.getElementById('cpr-' + id);
    if (row && !row.querySelector('.cp-warn')) {
      const warn = document.createElement('div');
      warn.className = 'cp-warn';
      warn.textContent = `${count} Memo${count > 1 ? 's' : ''} vorhanden — nicht löschbar`;
      row.appendChild(warn);
      setTimeout(() => warn.remove(), 3000);
    }
    return;
  }
  if (!confirm(`Pfad "${getPathName(id)}" löschen?`)) return;
  customPaths = customPaths.filter(p => p.id !== id);
  saveCustomPaths();
  if (currentFilter === id) {
    currentFilter = 'all';
    document.querySelectorAll('.path-btn, .mobile-filter-btn, .cat-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('[data-filter="all"]').forEach(b => b.classList.add('active'));
    document.getElementById('mainTitle').innerHTML = '<span class="badge" style="background:var(--text-muted)"></span>ALLE MEMOS';
  }
  renderDynamicUI();
  renderEntries();
}

function toggleLLMPanel() {
  const panel = document.querySelector('.llm-panel');
  panel.classList.toggle('collapsed');
  document.getElementById('llmToggle').textContent =
    panel.classList.contains('collapsed') ? '▸' : '▾';
}

// ───────────────────────────────────────────────
// ROUTING — hash-based
// ───────────────────────────────────────────────
function navigateToDetail(id) {
  location.hash = 'memo/' + id;
}

function navigateBack() {
  location.hash = '';
}

function handleRoute() {
  const hash = location.hash.replace(/^#/, '');
  if (hash.startsWith('memo/')) {
    const id = hash.slice(5);
    showDetail(id);
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

  const textEl = document.getElementById('detailText');
  if (memo.html) {
    textEl.innerHTML = memo.html;
    textEl.className = 'detail-text detail-text--html';
  } else {
    textEl.textContent = memo.text;
    textEl.className = 'detail-text';
  }

  document.getElementById('detailEditBtn').onclick     = () => openEditor(id, null);
  document.getElementById('detailCopyBtn').onclick     = () => copyMemo(id, null);
  document.getElementById('detailDownloadBtn').onclick = () => downloadMemo(id, null);
  document.getElementById('detailDeleteBtn').onclick   = () => deleteMemo(id, null);

  document.getElementById('detailOverlay').classList.add('show');
}

function hideDetail() {
  document.getElementById('detailOverlay').classList.remove('show');
}

window.addEventListener('hashchange', handleRoute);
handleRoute();
