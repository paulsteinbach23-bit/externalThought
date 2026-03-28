# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Browser-based voice memo recorder and library. No build system, no dependencies, no server.

Files:
- `voice_memo_library.html` — markup only
- `style.css` — all styles
- `app.js` — all logic

To open: `open voice_memo_library.html`

## Architecture

Three files, three layers:

- **`style.css`** (`:root` variables → layout → components): Dark theme with CSS custom properties. All colors and fonts defined in `:root`.
- **`voice_memo_library.html`**: Two-column layout — `<aside class="sidebar">` (filter nav + record button) and `<main>` (entry list + search). A modal overlay handles the active recording UI.
- **`app.js`**: No framework. State is `memos[]` (persisted to `localStorage` as `voice_memos`) plus a few globals (`currentFilter`, `openId`, `isRecording`, `liveTranscript`).

### Recording flow

1. `toggleRecording()` → `startRecording()` initializes `SpeechRecognition` (Web Speech API, Chrome/Edge only)
2. `onresult` accumulates finals into `liveTranscript`, shows interim in modal
3. `onend` auto-restarts recognition (with 150ms delay + try/catch) to keep it alive
4. `stopRecording()` sets `isRecording = false`, nulls `onend`, calls `recognition.stop()`
5. `processTranscript()` detects path prefix ("Path A/B/C:"), prompts if missing, then calls `generateTitle()`
6. `saveMemoAndDownload()` saves to `memos[]` → `localStorage`, re-renders, and auto-downloads a `.txt` file

### Title generation

`generateTitle()` calls the Anthropic API (`claude-sonnet-4-20250514`). **No API key is configured** — the call will always fail and fall back to using the first 6 words of the transcript as the title. To enable AI titles, inject an `x-api-key` header (requires a proxy since direct API calls from the browser are blocked by Anthropic's CORS policy).

### Categories / paths

Three hard-coded categories detected by voice prefix:
- `Path A:` → Work (green `--accent-a`)
- `Path B:` → Research (blue `--accent-b`)
- `Path C:` → Business Ideas (orange `--accent-c`)
