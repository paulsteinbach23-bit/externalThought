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
let memos = JSON.parse(localStorage.getItem('voice_memos') || '[]');
let currentFilter = 'all';
let openId = null;
let editorId = null;
let mediaRecorder = null;
let audioChunks = [];
let recognition = null;
let isRecording = false;
let liveTranscript = '';
let liveInterim = '';

function saveMemos() {
  localStorage.setItem('voice_memos', JSON.stringify(memos));
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
const pathLabels = { A: 'WORK', B: 'RESEARCH', C: 'BUSINESS IDEAS' };
const pathColors = { A: 'var(--accent-a)', B: 'var(--accent-b)', C: 'var(--accent-c)' };

function setFilter(f, btn) {
  currentFilter = f;
  // Sync both desktop sidebar and mobile filter bar
  document.querySelectorAll('.path-btn, .mobile-filter-btn').forEach(b => b.classList.remove('active'));
  // Activate all buttons with matching data-filter
  document.querySelectorAll(`[data-filter="${f}"]`).forEach(b => b.classList.add('active'));
  const titleEl = document.getElementById('mainTitle');
  if (f === 'all') {
    titleEl.innerHTML = '<span class="badge" style="background:var(--text-muted)"></span>ALLE MEMOS';
  } else {
    titleEl.innerHTML = `<span class="badge" style="background:${pathColors[f]}"></span>${pathLabels[f]}`;
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

  // sort newest first
  filtered.sort((a,b) => b.ts - a.ts);

  // update counts
  document.getElementById('count-all').textContent = memos.length;
  document.getElementById('count-a').textContent = memos.filter(m=>m.path==='A').length;
  document.getElementById('count-b').textContent = memos.filter(m=>m.path==='B').length;
  document.getElementById('count-c').textContent = memos.filter(m=>m.path==='C').length;
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
      const tagClass = {A:'tag-a', B:'tag-b', C:'tag-c'}[m.path];
      const pathName = {A:'WORK', B:'RESEARCH', C:'BUSINESS IDEAS'}[m.path];
      const isOpen = openId === m.id;
      const expandContent = m.html
        ? m.html
        : escHtml(m.text).replace(/\n/g, '<br>');
      html += `
        <div class="entry-card${isOpen?' open':''}${m.isNew?' is-new':''}" onclick="toggleEntry('${m.id}')">
          <div>
            <div class="entry-path-tag ${tagClass}">
              <span style="width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block"></span>
              ${pathName}
            </div>
            <div class="entry-title">${escHtml(m.title)}</div>
            ${!isOpen ? `<div class="entry-preview">${escHtml(m.text.substring(0,140))}${m.text.length>140?'…':''}</div>` : ''}
          </div>
          <div class="entry-meta">${time}</div>
          ${isOpen ? `
            <div class="entry-expand${m.html?' entry-expand--html':''}">${expandContent}</div>
            <div class="entry-actions">
              <button class="btn-small" onclick="openEditor('${m.id}', event)">BEARBEITEN</button>
              <button class="btn-small" onclick="copyMemo('${m.id}', event)">KOPIEREN</button>
              <button class="btn-small" onclick="downloadMemo('${m.id}', event)">DOWNLOAD</button>
              <button class="btn-small danger" onclick="deleteMemo('${m.id}', event)">LÖSCHEN</button>
            </div>
          ` : ''}
        </div>`;
    });
  }

  container.innerHTML = html;
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toggleEntry(id) {
  openId = openId === id ? null : id;
  const memo = memos.find(m => m.id === id);
  if (memo && memo.isNew) {
    memo.isNew = false;
    saveMemos();
  }
  renderEntries();
}

function copyMemo(id, e) {
  e.stopPropagation();
  const m = memos.find(x=>x.id===id);
  if (m) navigator.clipboard.writeText(m.text);
}

function downloadMemo(id, e) {
  e.stopPropagation();
  const m = memos.find(x=>x.id===id);
  if (!m) return;
  const blob = new Blob([`MEMO // ${m.title}\nPath: ${pathLabels[m.path]}\nDate: ${new Date(m.ts).toLocaleString()}\n\n${m.text}`], {type:'text/plain'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = sanitizeFilename(m.title) + '.txt';
  a.click();
  URL.revokeObjectURL(url);
}

function deleteMemo(id, e) {
  e.stopPropagation();
  if (!confirm('Delete this memo?')) return;
  memos = memos.filter(x=>x.id!==id);
  if (openId===id) openId=null;
  saveMemos();
  renderEntries();
}

function sanitizeFilename(str) {
  return str.replace(/[^a-z0-9_\-\s]/gi,'').replace(/\s+/g,'_').toLowerCase().substring(0,60);
}

// ───────────────────────────────────────────────
// RECORDING — Web Speech API
// ───────────────────────────────────────────────
function toggleRecording() {
  if (isRecording) stopRecording();
  else startRecording();
}

function startRecording() {
  if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
    alert('Your browser does not support the Web Speech API.\nPlease use Chrome or Edge for voice recording.\n\nAlternatively, you can type your memo below using the manual input (double-click any empty area).');
    showManualInput();
    return;
  }

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
      document.getElementById('recordBtn').classList.remove('recording');
      document.getElementById('recordBtnText').textContent = 'Start Recording';
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
  document.getElementById('recordBtn').classList.add('recording');
  document.getElementById('recordBtnText').textContent = 'Aufnahme stoppen';
  document.getElementById('modalTitle').textContent = '// AUFNAHME LÄUFT';
  document.getElementById('modalOverlay').classList.add('show');
  document.getElementById('fabRecord').classList.add('recording');
}

function stopRecording() {
  isRecording = false;
  if (recognition) { recognition.onend = null; recognition.stop(); }

  document.getElementById('recordBtn').classList.remove('recording');
  document.getElementById('recordBtnText').textContent = 'Aufnahme starten';
  document.getElementById('fabRecord').classList.remove('recording');

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
  openId = memo.id;
  renderEntries();
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
  console.log('[processTranscript] raw:', JSON.stringify(t));

  let path = null;
  let cleanText = t;

  // Check first word against keyword map
  const firstWord = t.split(/[\s,.:;!?]+/)[0].toLowerCase().replace(/[^a-z0-9äöü]/g, '');
  console.log('[processTranscript] firstWord:', JSON.stringify(firstWord));

  if (KEYWORD_MAP[firstWord]) {
    path = KEYWORD_MAP[firstWord];
    const rest = t.slice(firstWord.length).replace(/^[\s,.:;]+/, '');
    cleanText = rest || t;
    console.log('[processTranscript] path detected:', path, '| cleanText:', JSON.stringify(cleanText));
  } else {
    console.log('[processTranscript] no path detected, prompting user');
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
  const categoryName = {A:'Work', B:'Research', C:'Business Ideas'}[path];
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

// ───────────────────────────────────────────────
// EDITOR
// ───────────────────────────────────────────────
function openEditor(id, event) {
  event.stopPropagation();
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
  tagEl.className  = 'editor-path-tag ' + {A:'tag-a', B:'tag-b', C:'tag-c'}[memo.path];
  tagEl.textContent = {A:'WORK', B:'RESEARCH', C:'BUSINESS IDEAS'}[memo.path];

  // LLM prompt
  const cat     = {A:'Work', B:'Research', C:'Business Ideas'}[memo.path];
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

function toggleLLMPanel() {
  const panel = document.querySelector('.llm-panel');
  panel.classList.toggle('collapsed');
  document.getElementById('llmToggle').textContent =
    panel.classList.contains('collapsed') ? '▸' : '▾';
}
