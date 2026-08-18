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
- `sw.js` — service worker; bump `CACHE` on every deploy or clients won't see new code
- `supabase_schema.sql` — original `voice_memos` schema, one-time setup run manually in the Supabase SQL editor
- `supabase_schema_v2.sql` — `captures`/`idea_documents` tables (PLAN V2), run manually alongside it
- `supabase_schema_v3_auth.sql` — adds a nullable `user_id` column to all three tables
- `supabase_schema_v3_auth_lockdown.sql` — backfills `user_id` on existing rows and replaces the wide-open `"allow all"` RLS policy with per-user `auth.uid() = user_id` (has the account owner's literal user id baked in — a one-time script, not something to re-run or generalize)

To open: `open index.html`, or serve the directory and let the service worker install.

## Architecture

- **`style.css`** (`:root` variables → layout → components): eggwhite-paper light theme by default, ink-black dark theme via `[data-theme="dark"]`. All colors and fonts defined in `:root`; serif body font for a professional, print-like feel.
- **`index.html`**: Single-column layout — just `<main>` (entry list + search) plus a floating action button for recording. No sidebar, no category tabs, no pre-recording picker — those were part of the old 5-path model and were removed in V2-P3. Modal overlays handle recording, the editor, and the detail view.
- **`app.js`**: No framework. Three parallel local-state arrays: `memos[]` (persisted as `voice_memos`, the original flat recorder model — now read-only/legacy, kept as a safety net and still rendered in the NOTIZEN view), `captures[]` (persisted as `captures`, the new home for everything recorded going forward — `kind: 'todo'|'idea'`), and `ideaDocuments[]` (persisted as `idea_documents`, created by filing inbox ideas or via "+ NEU"). A `currentView` global (`'memos'|'todos'|'inbox'|'docs'`, switched by the view-tabs, see `setView()`) decides what `renderEntries()` dispatches to. `editorId`/`editorMode` (`'memo'|'idea'`) track which collection the shared rich-text editor overlay is currently bound to. Script load order matters: `config.js` → `vendor/supabase.js` → `sync.js` → `app.js`.
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
- **Gotcha this actually hit:** editing `index.html` (e.g. adding the password field to the login form) after a device has already cached the old version via the service worker leaves that device's cached page missing the new field — `document.getElementById('loginPassword')` returns `null`, `.value` throws, and the login click silently does nothing with no visible error (the throw happens before the try/catch in `login()`). Symptom looks auth-related but is actually a stale-service-worker issue — fully closing and reopening the tab (not just backgrounding it) forces the SW update cycle. Bump `sw.js`'s `CACHE` on every deploy, as always, but know that a stale *client* can still lag behind it until it gets a fresh navigation.
- There is currently exactly one user (the account owner) and no sign-up UI — `signInWithPassword` only works against an already-existing `auth.users` row. Password was set directly via SQL (`update auth.users set encrypted_password = crypt(...), email_confirmed_at = ...`) since the Supabase Studio version in use didn't expose a "reset password" UI action.

### Title generation

`generateTitle()` calls the Anthropic API directly from the browser with no API key configured — it always fails and falls back to the first 6 words of the transcript. This only affects **PWA-recorded** captures (`source: 'pwa'`). Legacy memos from the local Mac pipeline (`source: 'mac'`) got their title from the pipeline's own model and arrived with `title` already set — the fallback logic never ran for them.

### Legacy memos (`memos[]` / `voice_memos`) — read-only

The original flat 5-path recorder model (`A`–`E`: Work/Research/Business Ideas/Sonstiges/To-Do). Fully superseded by `captures` for anything new — `voice_memos` is kept read-only as a safety net (see PLAN V2's locked decisions) and still renders in the entries list so old memos remain visible and searchable.

A one-time client-side migration (`migrateLegacyMemosToCaptures()`) copies every `voice_memos` row into `captures` on first load of this version: path `E` → `kind: 'todo'` (carrying `done`), paths `A`–`D` → `kind: 'idea', filed: false, legacyPath: <old path>`. It reuses the original memo's `id` as the capture's `id`. Guarded two ways: the `memo_schema_v3` localStorage flag is a fast-path skip, but since that's per-browser, a second device or a fresh/incognito session has no flag — the per-item `captures.some(c => c.id === memo.id)` check is what actually makes this idempotent *across devices*, since `captures[]` was just populated by `Sync.pull()` from the shared Supabase state. Without that check, a re-run on a new session would silently stomp newer captures-side edits (e.g. a to-do completion) with stale data reconstructed from `voice_memos`.

Note `toggleMemoDone()` (used by the NOTIZEN view's checkbox on legacy path-E items) still writes to `voice_memos.done` — a real, if narrow, exception to "voice_memos is read-only." Since the migrated capture counterpart is a separate row, toggling done from the NOTIZEN view and the TO-DO view are two independent writes to two different tables that can drift from each other. Not fixed as of V2-P5 — flagged as a known follow-up.

`getPathName()`/`getPathColor()`/`pathTagHtml()`/`applyPathTagStyle()` in `app.js` still exist, scoped explicitly to rendering legacy memos' path tags in the entries list, detail view, and editor. The old per-category CSS (`.tag-a`–`.tag-d`, sidebar, category tabs, path-picker/new-path modals, `customPaths[]`) was removed in V2-P3; `.tag-e` and the `--accent-a`–`--accent-d` variables were deliberately kept — the variables are woven into unrelated UI (sync indicator, theme toggle, spinner, editor save button) and `.tag-e`/`--accent-rec` still drive the to-do accent color. Legacy `A`–`D` tags now render without their old per-category hue (monochrome, inherited text color) since their dedicated CSS is gone — an intentional, cosmetic-only degradation for a model being retired.
