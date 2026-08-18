# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Browser-based voice capture tool, synced through Supabase. No build system, no server. Supabase is
the source of truth; `localStorage` is an offline cache plus a write-outbox for edits made without a
connection. See `PLAN.md` for the original Supabase-migration rationale. Single-user, gated by
Supabase Auth (email + password) with per-user RLS — see "Auth" below.

ExternalThought is evolving from a flat voice-memo recorder into a personal thinking tool — see
`VISION.md` for the product direction and `/Users/paulsteinbach/.claude/plans/typed-sniffing-newt.md`
("PLAN V2") for the phased build-out. V2-P0 through V2-P5 are done (new `captures`/`idea_documents`
schema and sync, trigger-word capture flow, one-time legacy migration, old 5-path UI removed, a
to-do list and idea-inbox-with-merge-into-document UI). V2-P6 (canvas) is still pending.

Files:
- `index.html` — markup only
- `style.css` — all styles
- `app.js` — UI/recording/editor logic, local state
- `sync.js` — Supabase read/write layer (`Sync.*`)
- `config.js` — `SUPABASE_URL` / `SUPABASE_ANON_KEY`. Committed for real (not gitignored) — the anon key is meant to be public in client apps, and RLS now protects the data instead. `config.example.js` is a template for anyone standing up a separate Supabase project.
- `vendor/supabase.js` — vendored UMD build of `@supabase/supabase-js` (no CDN import, so the app still opens offline)
- `sw.js` — service worker; bump `CACHE` on every deploy or clients won't see new code. `index.html`'s registration script listens for `controllerchange` and force-reloads once — without it, an already-open tab/PWA instance (very common for a home-screen PWA) silently keeps running old HTML/JS indefinitely even after a successful deploy, since `skipWaiting()`+`clients.claim()` alone only affects the *next* navigation, not an already-loaded page.
- `supabase_schema.sql` — original `voice_memos` schema, one-time setup run manually in the Supabase SQL editor
- `supabase_schema_v2.sql` — `captures`/`idea_documents` tables (PLAN V2), run manually alongside it
- `supabase_schema_v3_auth.sql` — adds a nullable `user_id` column to all three tables
- `supabase_schema_v3_auth_lockdown.sql` — backfills `user_id` on existing rows and replaces the wide-open `"allow all"` RLS policy with per-user `auth.uid() = user_id` (has the account owner's literal user id baked in — a one-time script, not something to re-run or generalize)

To open: `open index.html`, or serve the directory and let the service worker install.

## Architecture

- **`style.css`** (`:root` variables → layout → components): eggwhite-paper light theme by default, ink-black dark theme via `[data-theme="dark"]`. All colors and fonts defined in `:root`; serif body font for a professional, print-like feel.
- **`index.html`**: Single-column layout — just `<main>` (entry list + search) plus a floating action button for recording. No sidebar, no category tabs, no pre-recording picker — those were part of the old 5-path model and were removed in V2-P3. Modal overlays handle recording, the editor, and the detail view.
- **`app.js`**: No framework. Three parallel local-state arrays: `memos[]` (persisted as `voice_memos`, the original flat recorder model — now read-only/legacy, kept as a safety net but no longer exposed via any tab), `captures[]` (persisted as `captures`, the new home for everything recorded going forward — `kind: 'todo'|'idea'`), and `ideaDocuments[]` (persisted as `idea_documents`, created by filing inbox ideas or via "+ NEU"). A `currentView` global (`'memos'|'todos'|'inbox'|'docs'`, default `'todos'`) decides what `renderEntries()` dispatches to. **The view-tabs UI label and the internal `currentView`/`data-view` value diverge on purpose**: the tab labeled "NOTIZEN" in the UI sets `currentView = 'inbox'` (it's the renamed idea-inbox tab, `setView('inbox')` in the HTML) — not the old legacy-memos view, which has no tab at all anymore (`'memos'` is only reachable by calling `setView('memos')` manually, e.g. from the console). Don't let the "inbox"-named functions (`renderInboxList()`, etc.) confuse you when the button says "NOTIZEN" — same view, renamed label. `editorId`/`editorMode` (`'memo'|'idea'`) track which collection the shared rich-text editor overlay is currently bound to. Script load order matters: `config.js` → `vendor/supabase.js` → `sync.js` → `app.js`.
- **`sync.js`**: IIFE exposing the `Sync` global — `init/pull/subscribe/resubscribe/upsert/softDelete/flushOutbox`, all entity-aware via a small registry (`ENTITIES.legacy/captures/idea_documents`). Every public method defaults its `entity` argument to `'legacy'`, so pre-V2 call sites (`Sync.upsert(memo)`, no second argument) keep working unchanged. If `config.js` is missing, `Sync.init()` warns and the app stays fully local (no hard dependency on Supabase being configured).

**Gotcha:** entity-registry object-literal properties like `save: saveMemos` evaluate the referenced function eagerly, at IIFE-construction time — before `app.js` has defined it — throwing `ReferenceError`. Always wrap in an arrow: `save: () => saveMemos()`.

### Sync flow

1. On load, `app.js` renders whatever is cached in `localStorage`, then calls `Sync.init()`.
2. `Sync.pull()` fetches all non-deleted rows for each entity (`legacy`/`captures`/`idea_documents`) and replaces the corresponding array wholesale (no per-row merge on initial load).
3. `Sync.subscribe()` opens one Postgres realtime channel with a listener per entity's table; inserts/updates/soft-deletes merge into the right array live via `mergeRowFor()`.
4. Writes update local state/`localStorage` immediately, then call `Sync.upsert(item, entity)` / `Sync.softDelete(id, entity)` (both default `entity` to `'legacy'`). On failure (offline, network error) the write is queued to `localStorage['memo_outbox']` and retried via `Sync.flushOutbox()` on the next `online` event or `Sync.init()`.
5. `visibilitychange → visible` triggers `Sync.resubscribe()` + `Sync.pull()`, because iOS kills the websocket when a PWA is backgrounded.
6. Deletes are soft (`deleted_at` set, row kept) — a hard delete would look identical to "was never synced" to a device that was offline when it happened.

**Outbox internals:** `_upsertRemoteFor`/`_softDeleteRemoteFor` are the raw network calls and throw on failure; only the public `upsert`/`softDelete` wrappers catch and queue. `flushOutbox()` calls the raw versions directly — if it called the public wrappers instead, a failed retry would re-queue via `queueOutbox()` right before `flushOutbox()` overwrites the outbox with its own (then-empty) `remaining` list, silently losing the item. Keep that split intact, per-entity.

### Recording flow

1. `onFabClick()` → `startRecording()` directly. No picker before you speak — that's the old 5-path model, removed in V2-P3.
2. `startRecording()` initializes `SpeechRecognition` (Web Speech API, Chrome/Edge only); other browsers fall back to `showManualInput()` (a plain `prompt()`)
3. `onresult` accumulates finals into `liveTranscript`, shows interim text in the modal
4. `onend` auto-restarts recognition (150ms delay + try/catch) to keep long recordings alive
5. `stopRecording()` shows a review/edit step (`reviewTextarea`); `confirmAndProcess()` hands the (possibly corrected) transcript to `processTranscript()`
6. `processTranscript()` checks the transcript's first word against `TODO_TRIGGERS` (`todo`, `aufgabe`) — a match strips the trigger word and routes to `kind: 'todo'`; everything else routes to `kind: 'idea'` (an unfiled inbox item). This always resolves — there's no ambiguity fallback or prompt.
7. `runTitleAndSaveCapture()` calls `generateTitle()`, then `saveCaptureAndDownload()` — new capture gets `id: crypto.randomUUID()`, `source: 'pwa'`, saves to `captures[]`/`localStorage`, and syncs to Supabase (`captures` table, not `voice_memos`)

New `kind: 'todo'` captures show up in the TO-DO view-tab (flat checklist, grouped Heute/Diese Woche/Älter, `toggleCaptureDone()`); new `kind: 'idea'` captures land in the IDEEN tab (unfiled inbox, `captures.filter(c => c.kind==='idea' && !c.filed)`).

### Idea documents — merge flow (V2-P5)

Clicking an inbox idea opens its detail view (`showCaptureDetail()`, routed via `#capture/<id>`) with an "EINORDNEN" action instead of "BEARBEITEN" — captures never get the rich editor, only `idea_documents.body_html` does. That opens the merge picker (`openMergePicker()`/`#mergePickerOverlay`): pick an existing document or type a title to create one, which sets `filed:true` + `ideaDocumentId` on the capture and removes it from the inbox. The DOKUMENTE tab lists `ideaDocuments[]`; its "+ NEU" button and clicking an existing document both open the same rich editor used for legacy memos, repointed via `editorMode`.

**Two sequencing gotchas fixed here, worth preserving:**
- `#mergePickerOverlay` is a `.modal-overlay` (z-index 100) opened *while* `#detailOverlay` (z-index 200) is still showing — `openMergePicker()` must hide the detail overlay first, or the picker renders fully occluded and unclickable. `closeMergePicker()` (the Cancel path) restores it if the hash still points at a capture; the success path (`fileIntoDocument()`) always navigates away instead.
- `makeIdeaDocument()` is `async` and `await`s `Sync.upsert(doc, 'idea_documents')` before returning. `captures.idea_document_id` is a foreign key — firing the capture's upsert before the document's has actually committed 409s on the FK. `fileIntoNewDocument()`/`createIdeaDocument()` both await it for this reason.

### Auth — single-user, email + password

Originally the app had no auth at all: RLS was `using (true)` on every table, so the anon key (necessarily public in any client-side Supabase app) let anyone read/write everything. Now every table has a `user_id` column and an `auth.uid() = user_id` RLS policy — confirmed by hand: an anon-key-only REST call now returns `[]` instead of data.

- **Email + password, not magic link.** Magic link was tried first and dropped — it depends on email delivery (Supabase's default sender has a very low rate limit, hit almost immediately during testing) and requires the redirect URL to exactly match an allow-listed entry per origin, which broke across Mac/phone testing. Password auth has neither problem: `Sync.signInWithPassword(email, password)` completes synchronously, no email round-trip, no redirect URL to configure.
- **Auth gates sync, never plain local use.** If `config.js` is missing entirely, `Sync.getSession()`/`ensureClient()` short-circuit and the app stays fully local exactly as before auth existed — login only matters when Supabase is actually configured.
- `app.js`'s `bootApp()` calls `Sync.getSession()` first; if there's a session, `onLoggedIn()` runs immediately. If not (and Supabase is configured), `#loginOverlay` shows and blocks `Sync.init()` until `login()` succeeds. `onLoggedIn()` is guarded by a `_loggedInHandled` flag since it can fire from two places (the direct post-login call in `login()`, and `Sync.onAuthChange()`'s `SIGNED_IN` listener) — don't remove the guard, or a session restored on load plus a fresh login in the same tab would double-`Sync.init()`.
- `sync.js` tracks `currentUser` (set via `ensureClient()`'s `onAuthStateChange` listener and refreshed by `getSession()`/`signInWithPassword()`) and every `mapToRemote*()` function stamps `user_id: currentUser ? currentUser.id : null` on writes — this is transparent to app.js, which never has to think about `user_id` itself.
- **Gotcha this actually hit, twice:** editing `index.html` after a device has already cached the old version via the service worker leaves that device silently running stale markup/JS combinations — e.g. `document.getElementById('loginPassword')` returning `null` and throwing before a login form even existed for password auth, or three already-removed UI elements (clock, sun/moon icons) reappearing after a later deploy that never touched them. Symptoms look feature-related but are actually a stale-service-worker issue. Now mitigated by the `controllerchange` auto-reload in `index.html` (see the `sw.js` file entry above) — but that only forces a refresh once the new SW has *activated*, which still needs at least one navigation/foreground event to kick off, so a determined case may still need a manual close-and-reopen.
- There is currently exactly one user (the account owner) and no sign-up UI — `signInWithPassword` only works against an already-existing `auth.users` row. Password was set directly via SQL (`update auth.users set encrypted_password = crypt(...), email_confirmed_at = ...`) since the Supabase Studio version in use didn't expose a "reset password" UI action.

### Title generation

`generateTitle()` calls the Anthropic API directly from the browser with no API key configured — it always fails and falls back to the first 6 words of the transcript. This only affects **PWA-recorded** captures (`source: 'pwa'`). Legacy memos from the local Mac pipeline (`source: 'mac'`) got their title from the pipeline's own model and arrived with `title` already set — the fallback logic never ran for them.

### Legacy memos (`memos[]` / `voice_memos`) — read-only

The original flat 5-path recorder model (`A`–`E`: Work/Research/Business Ideas/Sonstiges/To-Do). Fully superseded by `captures` for anything new — `voice_memos` is kept read-only as a safety net (see PLAN V2's locked decisions) and still renders in the entries list so old memos remain visible and searchable.

A one-time client-side migration (`migrateLegacyMemosToCaptures()`) copies every `voice_memos` row into `captures` on first load of this version: path `E` → `kind: 'todo'` (carrying `done`), paths `A`–`D` → `kind: 'idea', filed: false, legacyPath: <old path>`. It reuses the original memo's `id` as the capture's `id`. Guarded two ways: the `memo_schema_v3` localStorage flag is a fast-path skip, but since that's per-browser, a second device or a fresh/incognito session has no flag — the per-item `captures.some(c => c.id === memo.id)` check is what actually makes this idempotent *across devices*, since `captures[]` was just populated by `Sync.pull()` from the shared Supabase state. Without that check, a re-run on a new session would silently stomp newer captures-side edits (e.g. a to-do completion) with stale data reconstructed from `voice_memos`.

Note `toggleMemoDone()` (used by the legacy memos view's checkbox on path-E items) still writes to `voice_memos.done` — a real, if narrow, exception to "voice_memos is read-only." Since the migrated capture counterpart is a separate row, toggling done from that view and the TO-DO tab are two independent writes to two different tables that can drift from each other. Not fixed as of V2-P5 — flagged as a known follow-up. This view has no tab pointing to it anymore (see the `app.js` architecture note above), so this only matters if it's ever re-exposed or reached via a stray `#memo/<id>` hash link.

`getPathName()`/`getPathColor()`/`pathTagHtml()`/`applyPathTagStyle()` in `app.js` still exist, scoped explicitly to rendering legacy memos' path tags in the entries list, detail view, and editor. The old per-category CSS (`.tag-a`–`.tag-d`, sidebar, category tabs, path-picker/new-path modals, `customPaths[]`) was removed in V2-P3; `.tag-e` and the `--accent-a`–`--accent-d` variables were deliberately kept — the variables are woven into unrelated UI (sync indicator, theme toggle, spinner, editor save button) and `.tag-e`/`--accent-rec` still drive the to-do accent color. Legacy `A`–`D` tags now render without their old per-category hue (monochrome, inherited text color) since their dedicated CSS is gone — an intentional, cosmetic-only degradation for a model being retired.
