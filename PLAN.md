# PLAN.md — Supabase-Sync für die MEMO-PWA

Arbeitsplan für die Integration der lokalen Mac-Pipeline
(Sprachmemo → mlx-whisper → Ollama → Supabase) in die bestehende PWA.

Dieses Dokument ist die Umsetzungsvorlage. `CLAUDE.md` beschreibt den **alten**
Stand und muss am Ende von P3 nachgezogen werden.

---

## 0. Getroffene Entscheidungen

| Frage | Entscheidung |
|---|---|
| Source of Truth | **Supabase.** `localStorage` ist ab sofort nur noch Offline-Cache. |
| Bestehende lokale Memos | **Obsolet.** Keine Migration. Einmaliges Backup, dann Reset. |
| Python-Skript anpassen | **Ja.** Skript sendet `path`, `title`, `source` direkt mit. |

Daraus folgt:

- Kein Migrationscode, kein ID-Mapping-Table.
- Kein Kategorie-Mapping in der App (nur defensiver Fallback).
- `generateTitle()` in `app.js` entfällt ersatzlos — Titel kommt vom lokalen Ollama-Modell.
- Neuer fixer Pfad **`D` — Sonstiges** ist Pflicht, sonst hat die Ollama-Kategorie
  „Sonstiges" kein Ziel.

---

## 1. Ist-Zustand (Analyse des bestehenden Codes)

Buildfrei, kein Framework: `index.html` + `style.css` + `app.js` + `sw.js` + `manifest.json`.

**Datenmodell lokal**

```js
// localStorage['voice_memos']
{ id: 'memo_<ts>', path: 'A'|'B'|'C'|'cp_<ts>', title, text, ts,
  isNew, html?, editorFont?, editorSize? }

// localStorage['voice_paths']
{ id: 'cp_<ts>', name, colorIdx }
```

**Die vier Schreibpunkte in `app.js`** (einziger Hebel für den Sync-Layer):

1. `saveMemoAndDownload()` — neues Memo
2. `saveEditor()` — Titel / HTML / Text / Font
3. `deleteMemo()` — Löschen
4. `showDetail()` — Reset von `isNew`

**Stolpersteine im Bestand**

- `sw.js` ist cache-first für alle Same-Origin-Assets → ohne Bump von `CACHE`
  wird der neue Code nie ausgeliefert.
- `id`-Format `memo_<ts>` ist inkompatibel mit `uuid` im Supabase-Schema.
- `generateTitle()` ruft die Anthropic-API ohne Key auf; der Call schlägt immer
  fehl und fällt auf „erste 6 Wörter" zurück.
- Datumsformatierung nutzt `en-GB`, obwohl das UI deutsch ist (kosmetisch, optional).

---

## 2. Supabase-Schema (final)

```sql
create table voice_memos (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz default now(),
  updated_at  timestamptz default now(),
  deleted_at  timestamptz,
  source_name text,
  source      text default 'mac',      -- 'mac' | 'pwa'
  path        text,                    -- 'A' | 'B' | 'C' | 'D' | 'cp_…'
  category    text,                    -- Ollama-Rohwert, nur informativ
  title       text,
  summary     text,
  transcript  text,
  body_html   text                     -- Editor-Output der PWA
);

-- Idempotenz: re-syncende iCloud-Dateien / LaunchAgent-Neustarts
-- überschreiben statt zu duplizieren.
create unique index voice_memos_source_name_uniq
  on voice_memos (source_name) where source_name is not null;

create index voice_memos_created_idx on voice_memos (created_at desc);

alter table voice_memos enable row level security;
create policy "allow all" on voice_memos for all using (true) with check (true);

alter publication supabase_realtime add table voice_memos;
```

**Optional (P4), geräteübergreifende Custom-Pfade:**

```sql
create table voice_paths (
  id         text primary key,        -- 'cp_<ts>'
  name       text not null,
  color_idx  int  not null default 0,
  created_at timestamptz default now()
);
alter table voice_paths enable row level security;
create policy "allow all" on voice_paths for all using (true) with check (true);
alter publication supabase_realtime add table voice_paths;
```

### Soft Delete

`deleted_at` ist nicht optional. Ein Hard Delete am Handy ist für ein Gerät, das
gerade offline war, unsichtbar — der Eintrag käme beim nächsten Pull zurück.
Alle Reads filtern `.is('deleted_at', null)`.

---

## 3. Änderungen an `watch_and_process.py`

### 3.1 Prompt um `title` erweitern

```python
CATEGORIES_PROMPT = (
    "Kategorisiere folgendes Sprachmemo in genau eine Kategorie: "
    "Arbeit, Forschung, Business-Idee, Sonstiges. "
    "Antworte NUR als JSON, ohne Markdown-Codeblock, in diesem Format:\n"
    '{{"category": "<Kategorie>", "title": "<max 6 Wörter>", '
    '"summary": "<ein Satz Zusammenfassung>"}}\n\n'
    "Memo:\n{transcript}"
)

PATH_MAP = {
    "Arbeit": "A",
    "Forschung": "B",
    "Business-Idee": "C",
    "Sonstiges": "D",
}
```

### 3.2 `push_to_supabase()` erweitern

- Zusätzliche Felder: `path`, `title`, `source: "mac"`
- Header ergänzen: `"Prefer": "resolution=merge-duplicates"`
- `path` aus `PATH_MAP.get(category, "D")`
- `title` leer → auf `summary[:60]` zurückfallen

### 3.3 Fehlerpfad härten

`except Exception` in `RecordingHandler.on_created` schluckt aktuell alles und
die Aufnahme ist stillschweigend verloren. Fehlgeschlagene Dateinamen in
`~/.voicewatcher_failed.log` schreiben, damit sie manuell nachziehbar sind.

---

## 4. Änderungen an der PWA

### 4.1 Neue Dateien

| Datei | Zweck |
|---|---|
| `config.js` | `SUPABASE_URL`, `SUPABASE_ANON_KEY`. **In `.gitignore`.** |
| `config.example.js` | Eingecheckte Vorlage mit Platzhaltern. |
| `vendor/supabase.js` | Einmalig heruntergeladene UMD-Build von `@supabase/supabase-js`. |
| `sync.js` | Pull, Realtime, Upsert, Soft-Delete, Outbox, Mapping. |

**Kein CDN-Import.** Die PWA soll offline starten; ein CDN-`<script>` bricht das.
Deshalb vendoren und in `PRECACHE` aufnehmen.

Ladereihenfolge in `index.html`:

```html
<script src="config.js"></script>
<script src="vendor/supabase.js"></script>
<script src="sync.js"></script>
<script src="app.js"></script>
```

### 4.2 API von `sync.js`

```js
Sync.init()            // Client bauen, pull(), subscribe(), flushOutbox()
Sync.pull()            // select('*').is('deleted_at', null).order('created_at', desc)
Sync.subscribe()       // postgres_changes '*' → mergeRow() → renderEntries()
Sync.upsert(memo)      // bei Fehler → Outbox
Sync.softDelete(id)    // set deleted_at = now()
Sync.flushOutbox()     // bei Load, 'online'-Event, nach jedem Erfolg
Sync.status            // 'online' | 'offline' | 'syncing' → Status-Bar
```

**Mapping Remote → Local**

| Supabase | Local |
|---|---|
| `id` | `id` |
| `created_at` | `ts` (`Date.parse`) |
| `title` | `title` (Fallback: `summary`) |
| `transcript` | `text` |
| `summary` | `summary` (neu, für Preview) |
| `body_html` | `html` |
| `path` | `path` (Fallback: `category` → `PATH_MAP`) |
| `source` | `source` (für Badge) |

**Outbox:** `localStorage['memo_outbox']` als Array von
`{ op: 'upsert'|'delete', payload, ts }`. Trotz „Supabase = Wahrheit" nötig,
sonst gehen Edits verloren, die ohne Netz entstehen.

**Konflikte:** Last-Write-Wins über `updated_at`. Für Solo-Nutzung ausreichend.

### 4.3 Anker in `app.js`

| Stelle | Änderung |
|---|---|
| `let memos = JSON.parse(...)` | Cache sofort rendern, dann `Sync.init()` |
| `saveMemoAndDownload()` | `id = crypto.randomUUID()`, `source:'pwa'`, `updatedAt` → `Sync.upsert()` |
| `saveEditor()` | `updatedAt` setzen → `Sync.upsert()` |
| `deleteMemo()` | `Sync.softDelete()` statt reinem Array-Filter |
| `showDetail()` / `isNew` | bleibt **lokal** (`localStorage['memo_seen']`), wird **nicht** synchronisiert |
| `getPathName()` / `getPathColor()` | Pfad `D` — Sonstiges ergänzen |
| `renderEntries()` | Preview = `summary || text` |
| `generateTitle()` | ersatzlos entfernen |
| `KEYWORD_MAP` | Keyword für `D` ergänzen (`sonstiges`, `d`, `vier`, `4`) |

`isNew` bewusst gerätelokal: sonst blinkt das „NEU"-Badge auf dem Gerät, an dem
man das Memo längst gelesen hat.

### 4.4 UI-Ergänzungen für Pfad `D`

`D` muss an **fünf** Stellen auftauchen — sonst ist die Kategorie unerreichbar:

1. Sidebar (`index.html`, `.path-btn` + `count-d`)
2. Category-Tabs (`.cat-tab`)
3. Record-Path-Overlay (`.record-path-btn.rp-d`)
4. Path-Picker-Modal (`.path-picker-option`)
5. Status-Bar (`stat-d`)

Plus in `style.css`: `--accent-d`, `.dot-d`, `.tag-d`, `.rp-d`,
`.cat-tab[data-filter="D"].active` — analog zu A/B/C, inkl. Light-Theme-Varianten.

### 4.5 Einmaliger Reset des Altbestands

```js
if (!localStorage.getItem('memo_schema_v2')) {
  const old = localStorage.getItem('voice_memos');
  if (old) localStorage.setItem('voice_memos_legacy_backup', old);
  localStorage.removeItem('voice_memos');
  localStorage.setItem('memo_schema_v2', '1');
}
```

Backup kostet nichts und rettet den Fall, dass doch etwas Wichtiges drin war.

### 4.6 Service Worker

- `CACHE` auf `memo-v3` bumpen (**bei jedem Deploy erneut**, sonst sieht niemand
  den neuen Code).
- `PRECACHE` um `config.js`, `vendor/supabase.js`, `sync.js` erweitern.
- Für die Entwicklungsphase: `app.js` / `sync.js` network-first mit
  Cache-Fallback ausliefern.
- Supabase-Requests laufen cross-origin und werden vom SW ohnehin nicht
  abgefangen — kein Eingriff nötig.

### 4.7 Realtime unter iOS

Websockets sterben, wenn iOS die PWA in den Hintergrund schiebt. Auf
`visibilitychange → visible`:

```js
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    Sync.resubscribe();
    Sync.pull();
  }
});
```

Ohne das wirkt die App nach dem App-Switch „eingefroren".

---

## 5. Sicherheitshinweis (bewusst akzeptiert)

„Key als Config, nicht hardcoded" ist bei einer statischen PWA **Repo-Hygiene,
kein Geheimnisschutz** — der Anon-Key steht immer im ausgelieferten Client.
Zusammen mit `using (true)` kann jeder, der URL und Key kennt, alles lesen,
ändern und löschen.

Für ein privates Tool ohne Klinik-/Patientenbezug akzeptabel. **Sobald die PWA
öffentlich erreichbar deployt wird**, ist P5 (Anonymous Sign-in + RLS auf
`auth.uid()`) fällig.

---

## 6. Phasen & Akzeptanzkriterien

### P0 — Setup
Schema anlegen, Realtime aktivieren, Keys in `config.js` und ins Python-Skript.
**Fertig, wenn** ein vom Mac erzeugtes Testmemo in der Supabase-Tabelle steht —
mit korrekt gefüllten `path`, `title`, `summary`.

### P1 — Read-only Sync
`sync.js` mit `pull()` + `subscribe()`, Pfad `D` im UI, Reset des Altbestands.
Schreibpfade noch unverändert lokal.
**Fertig, wenn** eine Aufnahme am iPhone ohne Reload in der PWA erscheint und in
der richtigen Kategorie landet.

### P2 — Write Sync
`Sync.upsert()` / `Sync.softDelete()` an den vier Schreibpunkten, Outbox,
`visibilitychange`-Handling.
**Fertig, wenn** ein Edit am Handy im Flugmodus nach Wiederverbindung am Mac
ankommt — und ein gelöschtes Memo nicht wieder auftaucht.

### P3 — UI-Feinschliff
`summary` als Preview, Source-Badge (Mac/PWA) auf der Entry-Card,
Sync-Status in der Status-Bar, `sw.js`-Bump, **`CLAUDE.md` aktualisieren**.
**Fertig, wenn** auf einen Blick erkennbar ist, woher ein Memo stammt und ob der
Sync steht.

### P4 — Custom-Pfade synchronisieren (optional)
Tabelle `voice_paths`, Pull + Realtime, `saveNewPath()` / `deleteCustomPath()`
schreiben nach Supabase.

### P5 — Optional
Audio-Upload in Supabase Storage (Skript + Schema + Player im Detail-View),
Auth mit engerer RLS.

---

## 7. Offene Punkte

- **Custom-Pfade sind bis P4 gerätelokal.** Ein am Handy angelegter Pfad ist auf
  dem Laptop leer. Wenn das stört: `voice_paths` in P1 vorziehen — es ist eine
  Tabelle mit drei Spalten.
- **Audiodatei bleibt auf dem Mac.** Abspielen am Handy erfordert P5.
- **In-App-Recording** (Web Speech API) funktioniert weiterhin nur in
  Chrome/Edge und ist damit faktisch der Zweitweg neben der Mac-Pipeline.
  Über `source: 'pwa'` unterscheidbar.
- **Mac muss wach sein.** Aufnahmen gehen nicht verloren, werden aber erst
  verarbeitet, wenn er wieder läuft — im UI ggf. erwartbar machen.
