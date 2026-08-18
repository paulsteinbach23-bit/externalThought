# VISION.md — Product direction for ExternalThought v2

Captured from a brainstorming conversation on 2026-08-16. This is a **product vision**,
not an implementation plan — no AI classification, no execution/agent layer, no data
model decided yet. Those come later, once this direction feels right to live with.
`PLAN.md` documents the P0–P3 Supabase-sync migration (done); this doc is the next
layer on top of it: what the app is *for*, once sync is a solved problem.

## The core reframe

The app is not a recorder-with-folders. Voice is just the fastest way to get raw
material *in*. The actual product is what happens after: a place where captured
thoughts get manually structured, connected, and turned into documents you keep
working on — mind maps, linked ideas, a "second brain" you build by hand, not one
the AI builds for you.

Two very different modes, on purpose:

- **Capture** — fast, frictionless, happens anywhere (mostly phone). Zero decisions.
- **Building** — deliberate, unhurried, happens mostly at a laptop. This is where
  ideas actually get worked.

## Capture flow (simplified)

Today: tap record → pick one of 5 paths (A–E) → then talk. That decision-before-
you've-said-anything is friction in the wrong place.

New flow: tap record → talk immediately. No picker.

The only real-time split that survives is **to-do vs. idea**, and it's decided by
what you say, not by a button:

- Transcript starts with a trigger word ("to-do", "aufgabe", …) → routed straight to
  the to-do list (trigger word stripped, same way `KEYWORD_MAP` already strips path
  prefixes today).
- Anything else → lands in an **inbox** as a raw, unworked idea capture.

This reuses the existing first-word-detection mechanism, just collapsed from 5
buckets to 2. The other categories (Work/Research/Misc) go away as *capture-time*
decisions — structure now happens later, during building sessions, not at the mic.

## To-do list

Stays deliberately boring. A flat, trustworthy checklist — what do I have to do.
No AI, no automation (that's an explicitly future conversation). Possible small
improvements worth a checkbox model already supports: a "today/this week" view so
it doesn't get buried, optional due dates, and the ability to link a to-do to the
idea document it came from (without to-do-land turning into idea-land).

## Ideas: inbox → building sessions

New idea captures land in an inbox — raw transcripts, unsorted, waiting. Nothing
forces you to file them right away. During a deliberate building session (laptop),
you pull inbox items into existing idea documents or spin up new ones. This is the
"merge later" model: capture stays frictionless, all the organizing judgment
happens when you're actually sitting down to think, not mid-recording.

## Idea documents: two connected views

Each idea has two views of the same underlying material, meant to feed each other
(a canvas node becomes a paragraph; a paragraph spins off as a node):

**Document view** — the narrative. Written prose, structure, the existing rich-text
editor's natural home. Where an idea becomes readable, shareable, "finished."

**Canvas view** — freeform, spatial, laptop-first (confirmed: not designed around
phone/touch). A real infinite canvas where you place and wire together nodes.

### Canvas node types

- **Sticky note** — free text, written directly on the canvas.
- **Embedded transcript** — a whole raw memo pulled in from the inbox, presumably
  collapsible/expandable rather than always showing full text.
- **Image** — photos, sketches, screenshots dropped onto the board.
- **Link preview** — an external URL with title/preview, e.g. reference material.
- **Cross-idea link** — a node that *is* another idea document. Visually distinct
  (a "portal" into that idea) so it reads differently from local content.

Connectors between nodes, optionally labeled, express relationships.

### The "board of boards" pattern

Because a node can point at another idea document, nothing extra is needed to build
a meta-board — e.g. a "2026 Business Plans" idea whose canvas is just three
cross-idea-link nodes plus arrows/annotations showing how those three ideas relate
to each other. This falls out of the node model rather than being a separate
feature — worth keeping the node schema general enough that this stays true.

## Explicitly out of scope for now (parked, not forgotten)

- **AI classification / auto-linking.** No automatic "this transcript is probably
  about idea X" suggestion yet. All linking and filing is manual, by design, for
  this phase.
- **Task execution / agent actions** (e.g. drafting an email from a to-do). Agreed
  as a real future direction, but not something to design around yet. When it
  happens, draft-then-review was the instinct discussed, not autonomous send —
  revisit when this becomes active.
- **Idea lifecycle / status markers** (raw spark → exploring → cohesive doc →
  shipped). Sounded interesting in discussion but explicitly not a priority —
  maturity can just be judged by how built-out a document looks, for now.

## Open questions for the next round of discussion

- Canvas library/approach (not decided — this doc stays product-level on purpose).
- Exact inbox → idea "merge" interaction: drag-and-drop onto canvas? A picker from
  within the document view? Needs its own mini-brainstorm once this direction feels
  settled.
- What happens to the *existing* 5-path data (`A`–`E`, `done` on path `E`) during a
  transition — out of scope for this doc, but `PLAN.md`'s P4/P5 section is the
  precedent for how migrations here have been staged before.
