(() => {
  const MANIFEST_URL = "../data/slices/manifest.json";
  const SLICE_URL = (filename) => `../data/slices/${encodeURIComponent(filename)}`;
  const isSvgFilename = (filename) => /\.svg$/i.test(filename);
  const STORAGE_KEY = "annotator:apple:v2";
  const TYPE_LABELS = { label: "Text label", pin: "Pin + description", mcq: "MCQ" };
  const DEFAULT_TOLERANCE = { mode: "radius", radius: 0.06 };

  const el = (id) => document.getElementById(id);
  const stage = el("stage");
  const svgHost = el("svgHost");
  const toleranceLayer = el("toleranceLayer");
  const markerLayer = el("markerLayer");
  const scrub = el("scrub");
  const playBtn = el("play");
  const readout = el("readout");
  const datasetInfo = el("datasetInfo");
  const annotationListEl = el("annotationList");
  const sliceAnnCountEl = el("sliceAnnCount");
  const totalAnnCountEl = el("totalAnnCount");
  const allAnnotationListEl = el("allAnnotationList");
  const sortOrderEl = el("sortOrder");
  const importBtn = el("importBtn");
  const importFile = el("importFile");
  const exportBtn = el("exportBtn");
  const clearBtn = el("clearBtn");
  const inspectorEl = el("inspector");
  const paletteHintEl = el("paletteHint");
  const PALETTE_HINT_DEFAULT = paletteHintEl.textContent;

  const state = {
    manifest: null,
    currentIndex: 1,
    annotations: [],
    selectedId: null,
    drawing: null, // { annId, points: [{x,y}] }
    armedType: null, // palette type staged for tap-to-place (touch-friendly path)
    playing: false,
    playTimer: null,
  };

  function uid() {
    return "a-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function loadStoredAnnotations() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.annotations));
    } catch {
      /* storage unavailable or full: annotations still live in memory */
    }
  }

  function normalizeTolerance(ann) {
    if (!ann.tolerance) ann.tolerance = { ...DEFAULT_TOLERANCE };
    if (typeof ann.tolerance.radius !== "number") ann.tolerance.radius = DEFAULT_TOLERANCE.radius;
    if (ann.tolerance.mode !== "polygon") ann.tolerance.mode = "radius";
  }

  // Abandoning a draw (navigating away, Escape, Cancel) without >=3 points
  // falls back to radius mode rather than leaving a dangling "polygon" mode
  // with nothing to show.
  function cancelDrawing() {
    if (!state.drawing) return null;
    const ann = state.annotations.find((a) => a.id === state.drawing.annId);
    state.drawing = null;
    stage.classList.remove("drawing-mode");
    if (ann) {
      const hasPolygon = Array.isArray(ann.tolerance.polygon) && ann.tolerance.polygon.length >= 3;
      if (!hasPolygon) ann.tolerance.mode = "radius";
    }
    return ann;
  }

  // --- dataset / slice loading --------------------------------------------

  async function init() {
    state.annotations = loadStoredAnnotations().map((a) => {
      const ann = { ...a, id: a.id || uid() };
      normalizeTolerance(ann);
      return ann;
    });

    const res = await fetch(MANIFEST_URL);
    state.manifest = await res.json();
    scrub.max = state.manifest.sliceCount;
    toleranceLayer.setAttribute("viewBox", `0 0 ${state.manifest.size} ${state.manifest.size}`);
    datasetInfo.textContent = `${state.manifest.sliceCount} slices · ${state.manifest.axis || ""}`;

    await loadSlice(1);
    renderGlobalList();
    wireGlobalControls();
  }

  // SVGs are fetched and injected inline so their shapes are real DOM
  // elements - that's what makes layer detection (elementFromPoint +
  // data-layer) possible. Any other image format (a real scan export -
  // PNG/JPG/etc.) is just rendered as a plain <img>; layer detection then
  // naturally finds nothing, which the rest of the app already treats as
  // "no layer" rather than an error.
  async function loadSliceImage(filename) {
    svgHost.innerHTML = "";
    if (isSvgFilename(filename)) {
      const res = await fetch(SLICE_URL(filename));
      svgHost.innerHTML = await res.text();
      return;
    }
    const img = document.createElement("img");
    img.src = SLICE_URL(filename);
    img.alt = "";
    img.draggable = false;
    svgHost.appendChild(img);
  }

  async function loadSlice(index) {
    state.currentIndex = index;

    cancelDrawing();
    if (state.selectedId) {
      const sel = state.annotations.find((a) => a.id === state.selectedId);
      if (!sel || sel.sliceIndex !== index) state.selectedId = null;
    }

    const filename = state.manifest.files[index - 1];
    await loadSliceImage(filename);
    scrub.value = index;
    readout.textContent = `${index} / ${state.manifest.sliceCount}`;

    renderMarkers();
    renderToleranceOverlay();
    renderAnnotationList();
    renderInspector();
  }

  function stopPlaying() {
    state.playing = false;
    playBtn.textContent = "Play";
    clearInterval(state.playTimer);
  }

  async function navigateToAnnotation(id) {
    const ann = state.annotations.find((a) => a.id === id);
    if (!ann) return;
    stopPlaying();
    if (ann.sliceIndex !== state.currentIndex) await loadSlice(ann.sliceIndex);
    selectAnnotation(id);
  }

  // --- layer detection ---------------------------------------------------

  function layerFromEventTarget(target) {
    const layerEl = target && target.closest ? target.closest("[data-layer]") : null;
    return layerEl ? layerEl.getAttribute("data-layer") : null;
  }

  function layerAtPoint(clientX, clientY, ignoreEl) {
    const prevDisplay = ignoreEl ? ignoreEl.style.display : null;
    if (ignoreEl) ignoreEl.style.display = "none";
    const target = document.elementFromPoint(clientX, clientY);
    if (ignoreEl) ignoreEl.style.display = prevDisplay;
    return layerFromEventTarget(target);
  }

  // --- selection -----------------------------------------------------------

  function selectAnnotation(id) {
    state.selectedId = id;
    state.drawing = null;
    stage.classList.remove("drawing-mode");
    setArmed(null);
    renderInspector();
    renderMarkers();
    renderToleranceOverlay();
    renderAnnotationList();
    renderGlobalList();
  }

  function deselectAnnotation() {
    if (!state.selectedId && !state.drawing) return;
    state.selectedId = null;
    state.drawing = null;
    stage.classList.remove("drawing-mode");
    setArmed(null);
    renderInspector();
    renderMarkers();
    renderToleranceOverlay();
    renderAnnotationList();
    renderGlobalList();
  }

  function removeAnnotation(id) {
    state.annotations = state.annotations.filter((a) => a.id !== id);
  }

  // --- markers ---------------------------------------------------------------

  function annotationsForCurrentSlice() {
    return state.annotations.filter((a) => a.sliceIndex === state.currentIndex);
  }

  function renderMarkers() {
    markerLayer.innerHTML = "";
    annotationsForCurrentSlice().forEach((ann) => markerLayer.appendChild(buildMarkerEl(ann)));
  }

  function buildMarkerEl(ann) {
    const div = document.createElement("div");
    div.className = `marker ${ann.type}` + (ann.id === state.selectedId ? " selected" : "");
    div.style.left = `${ann.x * 100}%`;
    div.style.top = `${ann.y * 100}%`;
    div.dataset.id = ann.id;

    if (ann.type === "label") {
      div.innerHTML = `<span class="dot"></span><span class="chip">${escapeHtml(ann.text || "Label")}</span>`;
    } else if (ann.type === "pin") {
      div.title = ann.title || "Pin";
      div.innerHTML = `<span class="icon-circle">i</span>`;
    } else if (ann.type === "mcq") {
      div.title = ann.question || "MCQ";
      div.innerHTML = `<span class="icon-circle">?</span>`;
    }

    wireMarkerDrag(div, ann);
    return div;
  }

  function wireMarkerDrag(div, ann) {
    div.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      div.setPointerCapture(e.pointerId);
      let dragging = false;
      let pendingX = ann.x;
      let pendingY = ann.y;
      const startX = e.clientX;
      const startY = e.clientY;

      const onMove = (moveEvt) => {
        const dx = moveEvt.clientX - startX;
        const dy = moveEvt.clientY - startY;
        if (!dragging && Math.hypot(dx, dy) > 8) dragging = true;
        if (!dragging) return;
        const rect = stage.getBoundingClientRect();
        pendingX = clamp((moveEvt.clientX - rect.left) / rect.width, 0, 1);
        pendingY = clamp((moveEvt.clientY - rect.top) / rect.height, 0, 1);
        div.style.left = `${pendingX * 100}%`;
        div.style.top = `${pendingY * 100}%`;
        renderToleranceOverlayThrottled();
      };

      const onUp = (upEvt) => {
        div.removeEventListener("pointermove", onMove);
        if (dragging) {
          ann.x = pendingX;
          ann.y = pendingY;
          const newLayer = layerAtPoint(upEvt.clientX, upEvt.clientY, div);
          if (newLayer) ann.layer = newLayer;
          persist();
          renderAnnotationList();
          renderGlobalList();
          renderToleranceOverlay();
        } else {
          selectAnnotation(ann.id);
        }
      };

      div.addEventListener("pointermove", onMove);
      div.addEventListener("pointerup", onUp, { once: true });
    });
  }

  let toleranceRaf = null;
  function renderToleranceOverlayThrottled() {
    if (toleranceRaf) return;
    toleranceRaf = requestAnimationFrame(() => {
      toleranceRaf = null;
      renderToleranceOverlay();
    });
  }

  // --- tolerance overlay (radius / custom polygon) ----------------------------

  function toleranceShapeMarkup(ann, size, isSelected) {
    const t = ann.tolerance;
    const cls = isSelected ? "tolerance selected" : "tolerance";
    if (t.mode === "polygon" && t.polygon && t.polygon.length >= 3) {
      const pts = t.polygon.map((p) => `${(p.x * size).toFixed(1)},${(p.y * size).toFixed(1)}`).join(" ");
      return `<polygon class="${cls}" points="${pts}" />`;
    }
    const r = (t.radius ?? DEFAULT_TOLERANCE.radius) * size;
    return `<circle class="${cls}" cx="${(ann.x * size).toFixed(1)}" cy="${(ann.y * size).toFixed(1)}" r="${r.toFixed(1)}" />`;
  }

  function renderToleranceOverlay() {
    if (!state.manifest) return;
    const size = state.manifest.size;
    const parts = [];

    annotationsForCurrentSlice().forEach((ann) => {
      normalizeTolerance(ann);
      parts.push(toleranceShapeMarkup(ann, size, ann.id === state.selectedId));
    });

    if (state.drawing) {
      const pts = state.drawing.points;
      if (pts.length) {
        const ptsAttr = pts.map((p) => `${(p.x * size).toFixed(1)},${(p.y * size).toFixed(1)}`).join(" ");
        parts.push(`<polyline class="draft-line" points="${ptsAttr}" />`);
        pts.forEach((p) => parts.push(`<circle class="draft-point" cx="${(p.x * size).toFixed(1)}" cy="${(p.y * size).toFixed(1)}" r="4" />`));
      }
    }

    toleranceLayer.innerHTML = parts.join("");
  }

  // --- palette placement: drag-and-drop (mouse) or tap-to-arm (touch) --------
  //
  // Native HTML5 drag-and-drop does not work on touch browsers (notably iOS
  // Safari), so placement is driven entirely by Pointer Events instead: a
  // press-and-move on a palette item drags a ghost chip onto the stage
  // (works with mouse, pen and touch alike); a plain tap "arms" that type so
  // the next tap on the stage places it there, which is far more reliable on
  // a scrolling touch layout than a long drag gesture.

  function isPointInRect(x, y, rect) {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function setArmed(type) {
    state.armedType = type;
    document.querySelectorAll(".palette-item").forEach((item) => {
      item.classList.toggle("armed", item.dataset.type === type);
    });
    stage.classList.toggle("armed-mode", !!type);
    paletteHintEl.textContent = type
      ? `Tap the slice to place a ${TYPE_LABELS[type]}. Tap the tool again to cancel.`
      : PALETTE_HINT_DEFAULT;
  }

  function placeAnnotation(type, clientX, clientY, rect) {
    const x = clamp((clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((clientY - rect.top) / rect.height, 0, 1);
    const layer = layerAtPoint(clientX, clientY, null);

    const ann = createDefaultAnnotation(type, x, y, layer);
    state.annotations.push(ann);
    persist();
    renderMarkers();
    renderToleranceOverlay();
    renderAnnotationList();
    renderGlobalList();
    selectAnnotation(ann.id);
  }

  function createGhost(type) {
    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.textContent = TYPE_LABELS[type];
    document.body.appendChild(ghost);
    return ghost;
  }

  function positionGhost(ghost, x, y) {
    ghost.style.left = `${x}px`;
    ghost.style.top = `${y}px`;
  }

  function beginPaletteInteraction(item, downEvent) {
    if (state.drawing) {
      cancelDrawing();
      renderInspector();
      renderToleranceOverlay();
    }

    const type = item.dataset.type;
    const startX = downEvent.clientX;
    const startY = downEvent.clientY;
    let dragging = false;
    let ghost = null;

    item.setPointerCapture(downEvent.pointerId);

    const cleanup = () => {
      item.removeEventListener("pointermove", onMove);
      item.removeEventListener("pointerup", onUp);
      item.removeEventListener("pointercancel", onCancel);
      stage.classList.remove("drag-over");
      if (ghost) ghost.remove();
    };

    const onMove = (e) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) > 10) {
        dragging = true;
        setArmed(null);
        ghost = createGhost(type);
      }
      if (!dragging) return;
      positionGhost(ghost, e.clientX, e.clientY);
      stage.classList.toggle("drag-over", isPointInRect(e.clientX, e.clientY, stage.getBoundingClientRect()));
    };

    const onUp = (e) => {
      cleanup();
      if (dragging) {
        const rect = stage.getBoundingClientRect();
        if (isPointInRect(e.clientX, e.clientY, rect)) placeAnnotation(type, e.clientX, e.clientY, rect);
      } else {
        setArmed(state.armedType === type ? null : type);
      }
    };

    const onCancel = () => cleanup();

    item.addEventListener("pointermove", onMove);
    item.addEventListener("pointerup", onUp);
    item.addEventListener("pointercancel", onCancel);
  }

  function wirePalette() {
    document.querySelectorAll(".palette-item").forEach((item) => {
      item.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        e.preventDefault();
        beginPaletteInteraction(item, e);
      });
    });

    stage.addEventListener("click", (e) => {
      if (state.drawing) {
        const rect = stage.getBoundingClientRect();
        const x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
        const y = clamp((e.clientY - rect.top) / rect.height, 0, 1);
        state.drawing.points.push({ x, y });
        const ann = state.annotations.find((a) => a.id === state.drawing.annId);
        rebuildToleranceControls(ann);
        renderToleranceOverlay();
        return;
      }
      if (state.armedType) {
        if (e.target.closest(".marker")) return;
        const rect = stage.getBoundingClientRect();
        placeAnnotation(state.armedType, e.clientX, e.clientY, rect);
        setArmed(null);
        return;
      }
      if (state.selectedId && !e.target.closest(".marker")) {
        deselectAnnotation();
      }
    });
  }

  function createDefaultAnnotation(type, x, y, layer) {
    const base = { id: uid(), type, sliceIndex: state.currentIndex, layer, x, y, tolerance: { ...DEFAULT_TOLERANCE } };
    if (type === "label") return { ...base, text: "" };
    if (type === "pin") return { ...base, title: "", description: "" };
    return {
      ...base,
      question: "What condition does this point to?",
      options: ["Rot", "Bite mark", "Healthy apple"],
      answer: "Rot",
    };
  }

  // --- annotation lists (per-slice + global) ---------------------------------

  function summaryFor(ann) {
    if (ann.type === "label") return ann.text || "(empty label)";
    if (ann.type === "pin") return ann.title || "(untitled pin)";
    return ann.question || "(untitled question)";
  }

  function iconHtmlFor(type) {
    if (type === "label") return '<span class="icon label"></span>';
    if (type === "pin") return '<span class="icon pin">i</span>';
    return '<span class="icon mcq">?</span>';
  }

  function renderAnnotationList() {
    const items = annotationsForCurrentSlice();
    sliceAnnCountEl.textContent = items.length;
    annotationListEl.innerHTML = "";

    if (!items.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No annotations on this slice yet.";
      annotationListEl.appendChild(li);
      return;
    }

    items.forEach((ann) => {
      const li = document.createElement("li");
      if (ann.id === state.selectedId) li.classList.add("active");
      li.innerHTML = `
        ${iconHtmlFor(ann.type)}
        <span class="label-text">${escapeHtml(summaryFor(ann))}</span>
        <span class="layer-tag">${escapeHtml(ann.layer || "—")}</span>
      `;
      li.addEventListener("click", () => selectAnnotation(ann.id));
      annotationListEl.appendChild(li);
    });
  }

  function sortAnnotations(list, order) {
    const copy = list.slice();
    if (order === "type") {
      return copy.sort((a, b) => TYPE_LABELS[a.type].localeCompare(TYPE_LABELS[b.type]) || a.sliceIndex - b.sliceIndex);
    }
    if (order === "title-asc") {
      return copy.sort((a, b) => summaryFor(a).localeCompare(summaryFor(b)));
    }
    if (order === "title-desc") {
      return copy.sort((a, b) => summaryFor(b).localeCompare(summaryFor(a)));
    }
    return copy.sort((a, b) => a.sliceIndex - b.sliceIndex);
  }

  function renderGlobalList() {
    totalAnnCountEl.textContent = state.annotations.length;
    const sorted = sortAnnotations(state.annotations, sortOrderEl.value);
    allAnnotationListEl.innerHTML = "";

    if (!sorted.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No annotations yet.";
      allAnnotationListEl.appendChild(li);
      return;
    }

    sorted.forEach((ann) => {
      const li = document.createElement("li");
      if (ann.id === state.selectedId) li.classList.add("active");
      li.innerHTML = `
        ${iconHtmlFor(ann.type)}
        <span class="label-text">${escapeHtml(summaryFor(ann))}</span>
        <span class="slice-tag">#${ann.sliceIndex}</span>
      `;
      li.addEventListener("click", () => navigateToAnnotation(ann.id));
      allAnnotationListEl.appendChild(li);
    });
  }

  // --- inspector ---------------------------------------------------------------

  function typeFieldsMarkup(ann) {
    if (ann.type === "label") {
      return `
        <label>Label text
          <input type="text" id="f-text" maxlength="40" value="${escapeHtml(ann.text || "")}" placeholder="e.g. Core" />
        </label>`;
    }
    if (ann.type === "pin") {
      return `
        <label>Title
          <input type="text" id="f-title" maxlength="60" value="${escapeHtml(ann.title || "")}" placeholder="e.g. Seed chamber" />
        </label>
        <label>Description
          <textarea id="f-desc" placeholder="Longer explanation for students">${escapeHtml(ann.description || "")}</textarea>
        </label>`;
    }
    return `
      <label>Question
        <input type="text" id="f-question" value="${escapeHtml(ann.question || "")}" />
      </label>
      <label>Options (one per line)
        <textarea id="f-options">${escapeHtml((ann.options || []).join("\n"))}</textarea>
      </label>
      <label>Correct answer
        <select id="f-answer"></select>
      </label>`;
  }

  function toleranceControlsMarkup(ann) {
    const t = ann.tolerance;

    if (t.mode !== "polygon") {
      const pct = Math.round((t.radius ?? DEFAULT_TOLERANCE.radius) * 100);
      return `
        <label>Radius <span id="radiusReadout">${pct}%</span>
          <input type="range" id="f-radius" min="2" max="30" step="1" value="${pct}" />
        </label>
        <p class="hint">Students must place their answer within this circle of the slice to be marked correct.</p>`;
    }

    const drawing = state.drawing && state.drawing.annId === ann.id;
    const hasPolygon = t.polygon && t.polygon.length >= 3;

    if (drawing) {
      const n = state.drawing.points.length;
      return `
        <p class="hint drawing">Click on the slice to add points (${n} so far, need at least 3).</p>
        <div class="tolerance-actions">
          <button id="undoPointBtn" ${n === 0 ? "disabled" : ""}>Undo point</button>
          <button id="finishShapeBtn" ${n < 3 ? "disabled" : ""}>Finish shape</button>
          <button id="cancelDrawBtn">Cancel</button>
        </div>`;
    }

    return `
      <p class="hint">${hasPolygon ? `Custom shape with ${t.polygon.length} points.` : "No custom shape yet — it doesn't need to surround the pin."}</p>
      <div class="tolerance-actions">
        <button id="drawShapeBtn">${hasPolygon ? "Redraw shape" : "Draw shape"}</button>
      </div>`;
  }

  function buildInspectorMarkup(ann) {
    return `
      <div class="inspector-header">
        <h2>${TYPE_LABELS[ann.type]}</h2>
        <button id="closeInspector" title="Close">×</button>
      </div>
      <p class="meta">Slice ${ann.sliceIndex} · layer: ${escapeHtml(ann.layer || "unassigned")}</p>
      ${typeFieldsMarkup(ann)}
      <div class="tolerance-section">
        <h3>Acceptable range</h3>
        <div class="tolerance-mode">
          <label><input type="radio" name="tolMode" value="radius" ${ann.tolerance.mode !== "polygon" ? "checked" : ""} /> Radius</label>
          <label><input type="radio" name="tolMode" value="polygon" ${ann.tolerance.mode === "polygon" ? "checked" : ""} /> Custom shape</label>
        </div>
        <div id="toleranceControls">${toleranceControlsMarkup(ann)}</div>
      </div>
      <div class="inspector-actions">
        <button id="deleteBtn" class="danger">Delete</button>
      </div>`;
  }

  function afterFieldChange() {
    persist();
    renderMarkers();
    renderAnnotationList();
    renderGlobalList();
  }

  function rebuildToleranceControls(ann) {
    el("toleranceControls").innerHTML = toleranceControlsMarkup(ann);
    bindToleranceControlsInner(ann);
  }

  function bindToleranceControlsInner(ann) {
    if (ann.tolerance.mode !== "polygon") {
      const slider = el("f-radius");
      const readoutEl = el("radiusReadout");
      slider.addEventListener("input", () => {
        ann.tolerance.radius = Number(slider.value) / 100;
        readoutEl.textContent = `${slider.value}%`;
        persist();
        renderToleranceOverlay();
      });
      return;
    }

    const drawBtn = el("drawShapeBtn");
    if (drawBtn) {
      drawBtn.addEventListener("click", () => {
        state.drawing = { annId: ann.id, points: [] };
        stage.classList.add("drawing-mode");
        rebuildToleranceControls(ann);
        renderToleranceOverlay();
      });
    }
    const undoBtn = el("undoPointBtn");
    if (undoBtn) {
      undoBtn.addEventListener("click", () => {
        state.drawing.points.pop();
        rebuildToleranceControls(ann);
        renderToleranceOverlay();
      });
    }
    const finishBtn = el("finishShapeBtn");
    if (finishBtn) {
      finishBtn.addEventListener("click", () => {
        ann.tolerance.polygon = state.drawing.points.slice();
        ann.tolerance.mode = "polygon";
        state.drawing = null;
        stage.classList.remove("drawing-mode");
        persist();
        rebuildToleranceControls(ann);
        renderToleranceOverlay();
      });
    }
    const cancelBtn = el("cancelDrawBtn");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => {
        cancelDrawing();
        rebuildToleranceControls(ann);
        renderToleranceOverlay();
      });
    }
  }

  function wireInspector(ann) {
    el("closeInspector").addEventListener("click", deselectAnnotation);
    el("deleteBtn").addEventListener("click", () => {
      removeAnnotation(ann.id);
      persist();
      deselectAnnotation();
      renderMarkers();
      renderToleranceOverlay();
      renderAnnotationList();
      renderGlobalList();
    });

    if (ann.type === "label") {
      el("f-text").addEventListener("input", (e) => {
        ann.text = e.target.value;
        afterFieldChange();
      });
    } else if (ann.type === "pin") {
      el("f-title").addEventListener("input", (e) => {
        ann.title = e.target.value;
        afterFieldChange();
      });
      el("f-desc").addEventListener("input", (e) => {
        ann.description = e.target.value;
        afterFieldChange();
      });
    } else {
      el("f-question").addEventListener("input", (e) => {
        ann.question = e.target.value;
        afterFieldChange();
      });
      const optionsTa = el("f-options");
      const answerSel = el("f-answer");
      const refreshOptions = (notify) => {
        const prev = answerSel.value || ann.answer;
        const lines = optionsTa.value.split("\n").map((s) => s.trim()).filter(Boolean);
        answerSel.innerHTML = lines.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("");
        answerSel.value = lines.includes(prev) ? prev : lines[0] || "";
        ann.options = lines;
        ann.answer = answerSel.value;
        if (notify) afterFieldChange();
      };
      refreshOptions(false);
      optionsTa.addEventListener("input", () => refreshOptions(true));
      answerSel.addEventListener("change", () => {
        ann.answer = answerSel.value;
        afterFieldChange();
      });
    }

    document.querySelectorAll('input[name="tolMode"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        ann.tolerance.mode = radio.value;
        persist();
        rebuildToleranceControls(ann);
        renderToleranceOverlay();
      });
    });
    bindToleranceControlsInner(ann);
  }

  function renderInspector() {
    const ann = state.annotations.find((a) => a.id === state.selectedId);
    if (!ann) {
      inspectorEl.innerHTML = `<p class="hint placeholder">Select an annotation on the slice, or drag a new one from the palette, to edit it here.</p>`;
      return;
    }
    inspectorEl.innerHTML = buildInspectorMarkup(ann);
    wireInspector(ann);
  }

  // --- export (with quiz/showcase prompt) ---------------------------------------

  function downloadAnnotations(exportMode, quizMode) {
    const payload = {
      version: 2,
      exportMode,
      ...(exportMode === "quiz" ? { quizMode } : {}),
      dataset: {
        size: state.manifest.size,
        sliceCount: state.manifest.sliceCount,
        axis: state.manifest.axis,
      },
      annotations: state.annotations,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "annotations.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function openExportModal() {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop open";
    backdrop.innerHTML = `
      <div class="modal">
        <h3>Export annotations</h3>
        <fieldset>
          <legend>What are you exporting this for?</legend>
          <label><input type="radio" name="exportMode" value="quiz" checked />
            <span><strong>Quiz</strong><br />Students place features themselves and get checked.</span>
          </label>
          <label><input type="radio" name="exportMode" value="showcase" />
            <span><strong>Showcase</strong><br />Read-only walkthrough of the annotated slices.</span>
          </label>
        </fieldset>
        <fieldset id="quizModeFieldset">
          <legend>How much should students be told?</legend>
          <label><input type="radio" name="quizMode" value="full" checked />
            <span><strong>Full challenge</strong><br />Find the right slice <em>and</em> the right spot.</span>
          </label>
          <label><input type="radio" name="quizMode" value="guided" />
            <span><strong>Guided</strong><br />Shown which slice each feature is on, only need to find the spot.</span>
          </label>
        </fieldset>
        <div class="modal-actions">
          <button id="exportCancelBtn">Cancel</button>
          <button id="exportDownloadBtn">Download</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const quizModeFieldset = backdrop.querySelector("#quizModeFieldset");
    backdrop.querySelectorAll('input[name="exportMode"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        quizModeFieldset.style.display = radio.value === "quiz" ? "" : "none";
      });
    });

    const close = () => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
    };
    function onKey(e) {
      if (e.key === "Escape") close();
    }
    backdrop.querySelector("#exportCancelBtn").addEventListener("click", close);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
    document.addEventListener("keydown", onKey);

    backdrop.querySelector("#exportDownloadBtn").addEventListener("click", () => {
      const exportMode = backdrop.querySelector('input[name="exportMode"]:checked').value;
      const quizMode = backdrop.querySelector('input[name="quizMode"]:checked').value;
      downloadAnnotations(exportMode, exportMode === "quiz" ? quizMode : undefined);
      close();
    });
  }

  // --- import / export / clear -------------------------------------------------

  function wireGlobalControls() {
    wirePalette();

    scrub.addEventListener("input", () => {
      stopPlaying();
      loadSlice(Number(scrub.value));
    });

    playBtn.addEventListener("click", () => {
      if (state.playing) {
        stopPlaying();
        return;
      }
      state.playing = true;
      playBtn.textContent = "Pause";
      state.playTimer = setInterval(() => {
        let next = state.currentIndex + 1;
        if (next > state.manifest.sliceCount) next = 1;
        loadSlice(next);
      }, 300);
    });

    sortOrderEl.addEventListener("change", renderGlobalList);

    exportBtn.addEventListener("click", openExportModal);

    importBtn.addEventListener("click", () => importFile.click());

    importFile.addEventListener("change", async () => {
      const file = importFile.files[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        if (!parsed || !Array.isArray(parsed.annotations)) throw new Error("Missing annotations array");
        if (state.annotations.length && !confirm("Replace current annotations with the imported file?")) return;
        state.annotations = parsed.annotations.map((a) => {
          const ann = { ...a, id: a.id || uid() };
          normalizeTolerance(ann);
          return ann;
        });
        deselectAnnotation();
        persist();
        renderMarkers();
        renderToleranceOverlay();
        renderAnnotationList();
        renderGlobalList();
      } catch (err) {
        alert("Could not import file: " + err.message);
      } finally {
        importFile.value = "";
      }
    });

    clearBtn.addEventListener("click", () => {
      if (!state.annotations.length) return;
      if (!confirm("Delete all annotations across every slice? This cannot be undone.")) return;
      state.annotations = [];
      deselectAnnotation();
      persist();
      renderMarkers();
      renderToleranceOverlay();
      renderAnnotationList();
      renderGlobalList();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (state.drawing) {
        cancelDrawing();
        renderInspector();
        renderToleranceOverlay();
      } else if (state.armedType) {
        setArmed(null);
      } else if (state.selectedId) {
        deselectAnnotation();
      }
    });
  }

  init();
})();
