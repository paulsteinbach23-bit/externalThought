# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Browser-based voice memo recorder and library, synced through Supabase. No build system, no server.
Supabase is the source of truth; `localStorage` is an offline cache plus a write-outbox for edits made
without a connection. See `PLAN.md` for the full migration rationale and schema.

Files:
- `index.html` — markup only
- `style.css` — all styles
- `app.js` — UI/recording/editor logic, local state
- `sync.js` — Supabase read/write layer (`Sync.*`)
- `config.js` — `SUPABASE_URL` / `SUPABASE_ANON_KEY`. **Gitignored** — copy from `config.example.js`.
- `vendor/supabase.js` — vendored UMD build of `@supabase/supabase-js` (no CDN import, so the app still opens offline)
- `sw.js` — service worker; bump `CACHE` on every deploy or clients won't see new code
- `supabase_schema.sql` — one-time schema setup, run manually in the Supabase SQL editor

To open: `open index.html`, or serve the directory and let the service worker install.

## Architecture

- **`style.css`** (`:root` variables → layout → components): Dark theme with CSS custom properties. All colors and fonts defined in `:root`; `[data-theme="light"]` overrides them for light mode.
- **`index.html`**: Two-column layout — `<aside class="sidebar">` (filter nav + record button) and `<main>` (entry list + search). Modal overlays handle recording, the path picker, the editor, and the detail view.
- **`app.js`**: No framework. State is `memos[]` (persisted to `localStorage` as `voice_memos`) plus a few globals (`currentFilter`, `editorId`, `isRecording`, `liveTranscript`). Script load order matters: `config.js` → `vendor/supabase.js` → `sync.js` → `app.js`.
- **`sync.js`**: IIFE exposing the `Sync` global — `init/pull/subscribe/resubscribe/upsert/softDelete/flushOutbox`. If `config.js` is missing, `Sync.init()` warns and the app stays fully local (no hard dependency on Supabase being configured).

### Sync flow

1. On load, `app.js` renders whatever is cached in `localStorage`, then calls `Sync.init()`.
2. `Sync.pull()` fetches all non-deleted rows and replaces `memos[]` wholesale (no per-row merge on initial load).
3. `Sync.subscribe()` opens a Postgres realtime channel; inserts/updates/soft-deletes merge into `memos[]` live via `mergeRow()`.
4. Writes (`saveMemoAndDownload`, `saveEditor`, `deleteMemo`) update `memos[]`/`localStorage` immediately, then call `Sync.upsert()` / `Sync.softDelete()`. On failure (offline, network error) the write is queued to `localStorage['memo_outbox']` and retried via `Sync.flushOutbox()` on the next `online` event or `Sync.init()`.
5. `visibilitychange → visible` triggers `Sync.resubscribe()` + `Sync.pull()`, because iOS kills the websocket when a PWA is backgrounded.
6. Deletes are soft (`deleted_at` set, row kept) — a hard delete would look identical to "was never synced" to a device that was offline when it happened.

**Outbox internals:** `_upsertRemote`/`_softDeleteRemote` are the raw network calls and throw on failure; only the public `upsert`/`softDelete` wrappers catch and queue. `flushOutbox()` calls the raw versions directly — if it called the public wrappers instead, a failed retry would re-queue via `queueOutbox()` right before `flushOutbox()` overwrites the outbox with its own (then-empty) `remaining` list, silently losing the item. Keep that split intact.

### Recording flow

1. `onFabClick()` → `openRecordPathPicker()` — path is chosen *before* recording starts (`pickRecordPath()` sets `_recordPreselectedPath`)
2. `startRecording()` initializes `SpeechRecognition` (Web Speech API, Chrome/Edge only); other browsers fall back to `showManualInput()` (a plain `prompt()`)
3. `onresult` accumulates finals into `liveTranscript`, shows interim text in the modal
4. `onend` auto-restarts recognition (150ms delay + try/catch) to keep long recordings alive
5. `stopRecording()` shows a review/edit step (`reviewTextarea`); `confirmAndProcess()` hands the (possibly corrected) transcript to `processTranscript()`
6. If no path was preselected, `processTranscript()` matches the transcript's first word against `KEYWORD_MAP` (`a/anton/alpha/eins/1` → A, etc. through D); no match opens the styled path picker
7. `runTitleAndSave()` calls `generateTitle()`, then `saveMemoAndDownload()` — new memo gets `id: crypto.randomUUID()`, `source: 'pwa'`, saves to `memos[]`/`localStorage`, and syncs to Supabase

### Title generation

`generateTitle()` calls the Anthropic API directly from the browser with no API key configured — it always fails and falls back to the first 6 words of the transcript. This only affects **PWA-recorded** memos (`source: 'pwa'`). Memos from the local Mac pipeline (`source: 'mac'`) get their title from the pipeline's own model and arrive with `title` already set — the fallback logic never runs for them.

### Categories / paths

Four fixed categories, matched via `KEYWORD_MAP` in `processTranscript()` (not a literal spoken prefix):
- `A` → Work (`--accent-a`, green)
- `B` → Research (`--accent-b`, olive/yellow-green)
- `C` → Business Ideas (`--accent-c`, gold)
- `D` → Sonstiges/Misc (`--accent-d`, steel blue) — catch-all target for the Mac pipeline's Ollama categorizer

Each path touches five UI spots (sidebar, category tabs, record-path overlay, path-picker modal, status bar) plus `--accent-*`/`.dot-*`/`.tag-*`/`.rp-*` in `style.css`. Users can also add unlimited custom paths (`customPaths[]`, `cp_<ts>` ids, `voice_paths` in `localStorage`) — these are still device-local; see `PLAN.md` P4 for syncing them.
