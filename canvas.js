// ───────────────────────────────────────────────
// CANVAS — freeform mind-map view for idea documents (PLAN V2-P6)
// Hand-built: CSS-transform pan/zoom container + Pointer Events + absolute-
// positioned real DOM nodes (no canvas-bitmap library, no vendored engine).
// Laptop-focused per VISION.md — Pointer Events give basic single-finger
// drag "for free" on touch, but no multi-touch pinch-zoom is implemented;
// the +/- toolbar buttons are the deliberate touch-friendly zoom path.
//
// Persists into idea_documents.canvas ({nodes,edges}) and .viewport
// ({panX,panY,zoom}) via Sync.upsert(doc, 'idea_documents') — same entity
// sync.js already round-trips correctly for the rich-text editor. Debounced
// autosave (see AUTOSAVE_DELAY_MS) rather than a manual save button: a
// building session can run many minutes and losing it to an accidental
// navigation is the failure mode this exists to prevent.
//
// Depends on: app.js globals (ideaDocuments, saveIdeaDocuments, escHtml),
// Sync (sync.js). Loaded before app.js in index.html, but that's not load-
// bearing — none of this runs until openCanvasView() (app.js) calls in,
// well after all scripts have executed, same deferred-reference pattern
// sync.js already uses for its app.js globals.
// ───────────────────────────────────────────────
const Canvas = (() => {
  const AUTOSAVE_DELAY_MS = 4000;
  const ZOOM_MIN = 0.2, ZOOM_MAX = 3;
  const DRAG_THRESHOLD = 6; // px before a pointerdown commits to a drag, not a tap

  let boundDocId = null;
  let nodes = [];
  let edges = [];
  let panX = 0, panY = 0, zoom = 1;

  let saveTimer = null;
  let dirty = false;

  let viewportEl = null, surfaceEl = null, edgesEl = null;

  // Single-pointer drag state — one drag at a time, no gesture arbitration.
  let activePointerId = null;
  let dragMode = null; // 'pan' | 'node' | null
  let dragNodeId = null;
  let dragStartX = 0, dragStartY = 0;
  let dragMoved = 0;
  let panStartX = 0, panStartY = 0;
  let nodeStartX = 0, nodeStartY = 0;

  function init(viewport, surface, edgesSvg) {
    if (viewportEl) return; // already initialized — DOM elements are static, listeners attach once
    viewportEl = viewport;
    surfaceEl = surface;
    edgesEl = edgesSvg;

    viewportEl.style.touchAction = 'none';
    viewportEl.addEventListener('pointerdown', onPointerDown);
    viewportEl.addEventListener('pointermove', onPointerMove);
    viewportEl.addEventListener('pointerup', onPointerUp);
    viewportEl.addEventListener('pointercancel', onPointerUp);
    viewportEl.addEventListener('wheel', onWheel, { passive: false });
  }

  function loadDocument(doc) {
    boundDocId = doc.id;
    const c = doc.canvas || { nodes: [], edges: [] };
    nodes = (c.nodes || []).map(n => ({ ...n, data: { ...n.data } }));
    edges = (c.edges || []).map(e => ({ ...e }));
    const vp = doc.viewport || {};
    panX = vp.panX || 0;
    panY = vp.panY || 0;
    zoom = vp.zoom || 1;
    dirty = false;
    renderAll();
    setSaveIndicator('saved');
  }

  function unloadDocument() {
    clearTimeout(saveTimer);
    saveTimer = null;
    boundDocId = null;
    nodes = [];
    edges = [];
    if (surfaceEl) surfaceEl.querySelectorAll('.canvas-node').forEach(el => el.remove());
  }

  function renderAll() {
    surfaceEl.querySelectorAll('.canvas-node').forEach(el => el.remove());
    nodes.forEach(renderNode);
    applyTransform();
  }

  function applyTransform() {
    surfaceEl.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  }

  function renderNode(node) {
    const el = document.createElement('div');
    el.className = 'canvas-node canvas-node--' + node.type;
    el.dataset.nodeId = node.id;
    el.style.left = node.x + 'px';
    el.style.top = node.y + 'px';
    el.style.width = (node.w || 200) + 'px';
    el.style.height = (node.h || 140) + 'px';

    if (node.type === 'sticky') {
      el.innerHTML =
        `<button class="canvas-node-delete" onclick="Canvas.deleteNode('${node.id}', event)" aria-label="Notiz löschen">×</button>` +
        `<div class="canvas-node-body" contenteditable="true">${escHtml(node.data.text || '')}</div>`;
      const body = el.querySelector('.canvas-node-body');
      // Stop pointerdown from reaching the viewport's pan/drag handler —
      // otherwise typing/selecting text would drag the node instead.
      body.addEventListener('pointerdown', e => e.stopPropagation());
      body.addEventListener('input', () => {
        node.data.text = body.innerText;
        scheduleSave();
      });

      // Same reason as .canvas-node-body: without this, onPointerDown sees
      // the delete button as "inside a .canvas-node" and treats it as a
      // drag start, calling setPointerCapture() on the viewport — per spec
      // that retargets the synthesized click event to the capturing
      // element, so the button's onclick never fires. Confirmed via real
      // mouse-driven testing, not a simulation artifact.
      const delBtn = el.querySelector('.canvas-node-delete');
      delBtn.addEventListener('pointerdown', e => e.stopPropagation());
    }

    surfaceEl.appendChild(el);
  }

  function onPointerDown(e) {
    if (activePointerId !== null) return;
    activePointerId = e.pointerId;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragMoved = 0;

    const nodeEl = e.target.closest('.canvas-node');
    if (nodeEl) {
      dragMode = 'node';
      dragNodeId = nodeEl.dataset.nodeId;
      const node = nodes.find(n => n.id === dragNodeId);
      if (!node) { dragMode = null; activePointerId = null; return; }
      nodeStartX = node.x;
      nodeStartY = node.y;
    } else {
      dragMode = 'pan';
      panStartX = panX;
      panStartY = panY;
    }
    viewportEl.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e) {
    if (e.pointerId !== activePointerId) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    dragMoved = Math.max(dragMoved, Math.hypot(dx, dy));

    if (dragMode === 'pan') {
      panX = panStartX + dx;
      panY = panStartY + dy;
      applyTransform();
    } else if (dragMode === 'node') {
      const node = nodes.find(n => n.id === dragNodeId);
      if (!node) return;
      // Screen-pixel delta maps to canvas-space at 1/zoom, since the node's
      // left/top live inside the already-scaled #canvasSurface.
      node.x = nodeStartX + dx / zoom;
      node.y = nodeStartY + dy / zoom;
      const el = surfaceEl.querySelector('.canvas-node[data-node-id="' + dragNodeId + '"]');
      if (el) {
        el.style.left = node.x + 'px';
        el.style.top = node.y + 'px';
      }
    }
  }

  function onPointerUp(e) {
    if (e.pointerId !== activePointerId) return;
    if (dragMoved > DRAG_THRESHOLD) scheduleSave(); // real pan/drag, not just a tap
    activePointerId = null;
    dragMode = null;
    dragNodeId = null;
  }

  function onWheel(e) {
    e.preventDefault();
    const rect = viewportEl.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.1 : 1 / 1.1);
  }

  function zoomAt(pointX, pointY, factor) {
    const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * factor));
    if (newZoom === zoom) return;
    // Keep the point under the cursor/center fixed while zooming.
    panX = pointX - (pointX - panX) * (newZoom / zoom);
    panY = pointY - (pointY - panY) * (newZoom / zoom);
    zoom = newZoom;
    applyTransform();
    scheduleSave();
  }

  function zoomBy(factor) {
    const rect = viewportEl.getBoundingClientRect();
    zoomAt(rect.width / 2, rect.height / 2, factor);
  }

  function zoomIn() { zoomBy(1.2); }
  function zoomOut() { zoomBy(1 / 1.2); }
  function zoomReset() {
    panX = 0;
    panY = 0;
    zoom = 1;
    applyTransform();
    scheduleSave();
  }

  let newNodeCascade = 0; // successive adds fan out diagonally instead of stacking exactly

  function addStickyNode() {
    const rect = viewportEl.getBoundingClientRect();
    const cx = (rect.width / 2 - panX) / zoom;
    const cy = (rect.height / 2 - panY) / zoom;
    const offset = (newNodeCascade % 6) * 24;
    newNodeCascade++;
    const node = {
      id: crypto.randomUUID(),
      type: 'sticky',
      x: cx - 100 + offset,
      y: cy - 70 + offset,
      w: 200,
      h: 140,
      data: { text: '' },
    };
    nodes.push(node);
    renderNode(node);
    scheduleSave();
  }

  function deleteNode(id, e) {
    if (e) e.stopPropagation();
    nodes = nodes.filter(n => n.id !== id);
    edges = edges.filter(ed => ed.from !== id && ed.to !== id);
    const el = surfaceEl.querySelector('.canvas-node[data-node-id="' + id + '"]');
    if (el) el.remove();
    scheduleSave();
  }

  function scheduleSave() {
    dirty = true;
    setSaveIndicator('dirty');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, AUTOSAVE_DELAY_MS);
  }

  function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!dirty || !boundDocId) return;
    const doc = ideaDocuments.find(d => d.id === boundDocId);
    if (!doc) return;
    setSaveIndicator('saving');
    doc.canvas = {
      nodes: nodes.map(n => ({ ...n, data: { ...n.data } })),
      edges: edges.map(e => ({ ...e })),
    };
    doc.viewport = { panX, panY, zoom };
    doc.updatedAt = Date.now();
    saveIdeaDocuments();
    dirty = false;
    const p = (typeof Sync !== 'undefined') ? Sync.upsert(doc, 'idea_documents') : Promise.resolve();
    p.then(() => setSaveIndicator('saved'));
  }

  function setSaveIndicator(state) {
    const dot = document.getElementById('canvasSaveDot');
    const text = document.getElementById('canvasSaveText');
    if (!dot || !text) return;
    dot.className = 'sync-dot canvas-save-' + state;
    text.textContent = state === 'dirty' ? 'Ungespeichert' : state === 'saving' ? 'Speichern …' : 'Gespeichert';
  }

  return {
    init, loadDocument, unloadDocument, flushSave,
    addStickyNode, deleteNode,
    zoomIn, zoomOut, zoomReset,
  };
})();
