(() => {
  "use strict";
  const S = window.Scanner;
  const {
    el, clamp, escapeHtml, uid, TYPE_LABELS, DEFAULT_TOLERANCE,
    appliesToSlice, isMultiSlice, hasOverride, zoneFor, rangeLabel,
    summaryFor, iconHtmlFor, sortAnnotations, toleranceShapeMarkup,
  } = S;

  const MANIFEST_URL = "../data/slices/manifest.json";
  const SLICE_URL = (filename) => `../data/slices/${encodeURIComponent(filename)}`;
  const LEGACY_STORAGE_KEY = "annotator:apple:v2";
  const LEGACY_BACKUP_KEY = "annotator:legacy-backup:v2";

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
    store: null,
    loader: null,
    player: null,
    currentIndex: 1,
    annotations: [],
    selectedId: null,
    drawing: null, // { annId, points: [{x,y}] }
    armedType: null, // palette type staged for tap-to-place (touch-friendly path)
    // For a multi-slice annotation: "all" edits the default zone, "slice"
    // edits (creating if needed) this slice's override.
    editScope: "all",
  };

  // --- persistence -----------------------------------------------------------------

  function persist() {
    if (!state.store) return;
    const ok = state.store.write(state.annotations);
    if (ok) {
      S.dismissNotice("storage");
    } else {
      S.notify("warn", "Autosave isn't working in this browser, so changes will be lost when the page reloads. Use Export annotations to keep your work.", { id: "storage", dismissible: false });
    }
  }

  async function restoreAnnotations() {
    const saved = state.store.read();
    if (Array.isArray(saved) && saved.length) {
      state.annotations = S.normalizeAnnotations(saved, state.manifest.sliceCount).annotations;
      return;
    }
    // One-time recovery of work saved by the previous version, which used a
    // single shared key. Declining moves it to a backup key so it's neither
    // offered again nor lost.
    const legacy = S.createStore(LEGACY_STORAGE_KEY);
    const old = legacy.read();
    if (!Array.isArray(old) || !old.length) return;
    const yes = await S.confirmDialog({
      title: "Recover earlier annotations?",
      message: `${old.length} annotation${old.length === 1 ? "" : "s"} saved by an earlier version of the annotator were found. Recover them into this image stack? They were made before stacks were fingerprinted, so check they line up.`,
      confirmLabel: "Recover",
      cancelLabel: "Not now",
    });
    if (yes) {
      state.annotations = S.normalizeAnnotations(old, state.manifest.sliceCount).annotations;
      legacy.remove();
      persist();
    } else {
      S.createStore(LEGACY_BACKUP_KEY).write(old);
      legacy.remove();
    }
  }

  // --- init --------------------------------------------------------------------------

  async function init() {
    try {
      state.manifest = await S.loadManifest(MANIFEST_URL);
    } catch (err) {
      S.showFatal(err);
      return;
    }
    const m = state.manifest;
    state.store = S.createStore(`annotator:${m.datasetHash || "unfingerprinted"}:v3`);
    state.loader = S.createSliceLoader({ host: svgHost, manifest: m, sliceUrl: SLICE_URL });
    state.player = S.createPlayer({
      button: playBtn,
      interval: 300,
      step: () => loadSlice(state.currentIndex >= m.sliceCount ? 1 : state.currentIndex + 1),
    });

    scrub.max = m.sliceCount;
    toleranceLayer.setAttribute("viewBox", `0 0 ${m.size} ${m.size}`);
    datasetInfo.textContent = `${m.sliceCount} slices · ${m.axis || ""}`;

    if (!S.storageAvailable()) {
      S.notify("warn", "This browser is blocking storage (common inside an embedded frame), so autosave is off. Use Export annotations to keep your work.", { id: "storage", dismissible: false });
    }
    if (!m.datasetHash) {
      S.notify("info", "This image stack has no fingerprint, so exports can't be checked against it later. Run `python3 scripts/build_manifest.py` to add one.", { id: "nohash" });
    }

    await restoreAnnotations();
    await loadSlice(1);
    renderGlobalList();
    wireGlobalControls();
  }

  // --- slice navigation -------------------------------------------------------------

  async function loadSlice(index) {
    index = clamp(index, 1, state.manifest.sliceCount);
    cancelDrawing();
    const shown = await state.loader.load(index);
    if (!shown) return; // a later request took over
    state.currentIndex = index;
    if (state.selectedId) {
      const sel = findAnn(state.selectedId);
      if (!sel || !appliesToSlice(sel, index)) state.selectedId = null;
    }
    scrub.value = index;
    readout.textContent = `${index} / ${state.manifest.sliceCount}`;
    renderAll();
  }

  async function navigateToAnnotation(id) {
    const ann = findAnn(id);
    if (!ann) return;
    state.player.stop();
    if (!appliesToSlice(ann, state.currentIndex)) await loadSlice(ann.sliceFrom);
    selectAnnotation(id);
  }

  function findAnn(id) {
    return state.annotations.find((a) => a.id === id);
  }

  function annotationsForCurrentSlice() {
    return state.annotations.filter((a) => appliesToSlice(a, state.currentIndex));
  }

  // --- zone editing (default vs per-slice override) ---------------------------------

  /** The object whose x/y/tolerance the current edit should change. */
  function editTarget(ann) {
    if (isMultiSlice(ann) && state.editScope === "slice") {
      if (!ann.overrides[state.currentIndex]) {
        ann.overrides[state.currentIndex] = {
          x: ann.x,
          y: ann.y,
          tolerance: JSON.parse(JSON.stringify(ann.tolerance)),
        };
      }
      return ann.overrides[state.currentIndex];
    }
    return ann;
  }

  /** The zone currently displayed for the inspector's controls. */
  function viewZone(ann) {
    if (isMultiSlice(ann) && state.editScope === "slice") return zoneFor(ann, state.currentIndex);
    return ann;
  }

  function setRange(ann, from, to) {
    from = clamp(Math.round(from) || 1, 1, state.manifest.sliceCount);
    to = clamp(Math.round(to) || from, 1, state.manifest.sliceCount);
    if (from > to) [from, to] = [to, from];
    ann.sliceFrom = from;
    ann.sliceTo = to;
    for (const key of Object.keys(ann.overrides)) {
      const idx = Number(key);
      if (idx < from || idx > to) delete ann.overrides[key];
    }
    if (!isMultiSlice(ann)) state.editScope = "all";
  }

  // --- drawing a polygon zone --------------------------------------------------------

  // Abandoning a draw (navigating away, Escape, Cancel) without >=3 points
  // falls back to radius mode rather than leaving a dangling "polygon" mode
  // with nothing to show.
  function cancelDrawing() {
    if (!state.drawing) return;
    const ann = findAnn(state.drawing.annId);
    state.drawing = null;
    stage.classList.remove("drawing-mode");
    if (ann) {
      const zone = viewZone(ann);
      const hasPolygon = Array.isArray(zone.tolerance.polygon) && zone.tolerance.polygon.length >= 3;
      if (!hasPolygon) zone.tolerance.mode = "radius";
    }
  }

  // --- layer detection ---------------------------------------------------------------

  function layerAtPoint(clientX, clientY, ignoreEl) {
    const prevDisplay = ignoreEl ? ignoreEl.style.display : null;
    if (ignoreEl) ignoreEl.style.display = "none";
    const target = document.elementFromPoint(clientX, clientY);
    if (ignoreEl) ignoreEl.style.display = prevDisplay;
    const layerEl = target && target.closest ? target.closest("[data-layer]") : null;
    return layerEl ? layerEl.getAttribute("data-layer") : null;
  }

  // --- selection ----------------------------------------------------------------------

  function selectAnnotation(id) {
    if (state.selectedId !== id) state.editScope = "all";
    state.selectedId = id;
    state.drawing = null;
    stage.classList.remove("drawing-mode");
    setArmed(null);
    renderAll();
  }

  function deselectAnnotation() {
    if (!state.selectedId && !state.drawing) return;
    state.selectedId = null;
    state.drawing = null;
    state.editScope = "all";
    stage.classList.remove("drawing-mode");
    setArmed(null);
    renderAll();
  }

  function renderAll() {
    renderMarkers();
    renderToleranceOverlay();
    renderAnnotationList();
    renderGlobalList();
    renderInspector();
  }

  // --- markers -------------------------------------------------------------------------

  function renderMarkers() {
    markerLayer.innerHTML = "";
    annotationsForCurrentSlice().forEach((ann) => markerLayer.appendChild(buildMarkerEl(ann)));
  }

  function buildMarkerEl(ann) {
    const zone = zoneFor(ann, state.currentIndex);
    const div = document.createElement("div");
    div.className = `marker ${ann.type}`
      + (ann.id === state.selectedId ? " selected" : "")
      + (hasOverride(ann, state.currentIndex) ? " overridden" : "");
    div.style.left = `${zone.x * 100}%`;
    div.style.top = `${zone.y * 100}%`;
    div.dataset.id = ann.id;

    if (ann.type === "label") {
      div.innerHTML = `<span class="dot"></span><span class="chip">${escapeHtml(ann.text || "Label")}</span>`;
    } else if (ann.type === "pin") {
      div.title = ann.title || "Pin";
      div.innerHTML = `<span class="icon-circle">i</span>`;
    } else {
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
      const start = zoneFor(ann, state.currentIndex);
      let pendingX = start.x;
      let pendingY = start.y;
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
      };

      const onUp = (upEvt) => {
        div.removeEventListener("pointermove", onMove);
        if (!dragging) {
          selectAnnotation(ann.id);
          return;
        }
        if (ann.id !== state.selectedId) {
          state.selectedId = ann.id;
          state.editScope = "all";
        }
        const target = editTarget(ann);
        target.x = pendingX;
        target.y = pendingY;
        if (target === ann) {
          const newLayer = layerAtPoint(upEvt.clientX, upEvt.clientY, div);
          if (newLayer) ann.layer = newLayer;
        }
        persist();
        renderAll();
      };

      div.addEventListener("pointermove", onMove);
      div.addEventListener("pointerup", onUp, { once: true });
    });
  }

  // --- zone overlay -----------------------------------------------------------------------

  function renderToleranceOverlay() {
    if (!state.manifest) return;
    const size = state.manifest.size;
    const parts = [];

    annotationsForCurrentSlice().forEach((ann) => {
      const zone = zoneFor(ann, state.currentIndex);
      parts.push(toleranceShapeMarkup(zone, size, ann.id === state.selectedId ? "tolerance selected" : "tolerance"));
    });

    if (state.drawing && state.drawing.points.length) {
      const pts = state.drawing.points;
      const ptsAttr = pts.map((p) => `${(p.x * size).toFixed(1)},${(p.y * size).toFixed(1)}`).join(" ");
      parts.push(`<polyline class="draft-line" points="${ptsAttr}" />`);
      pts.forEach((p) => parts.push(`<circle class="draft-point" cx="${(p.x * size).toFixed(1)}" cy="${(p.y * size).toFixed(1)}" r="4" />`));
    }

    toleranceLayer.innerHTML = parts.join("");
  }

  // --- palette placement: drag-and-drop (mouse) or tap-to-arm (touch) -----------------
  //
  // Native HTML5 drag-and-drop does not work on touch browsers (notably iOS
  // Safari), so placement is driven entirely by Pointer Events instead: a
  // press-and-move on a palette item drags a ghost chip onto the stage
  // (works with mouse, pen and touch alike); a plain tap "arms" that type so
  // the next tap on the stage places it there.

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
    selectAnnotation(ann.id);
  }

  function createDefaultAnnotation(type, x, y, layer) {
    const base = {
      id: uid(), type, sliceFrom: state.currentIndex, sliceTo: state.currentIndex, layer, x, y,
      tolerance: { ...DEFAULT_TOLERANCE }, overrides: {},
    };
    if (type === "label") return { ...base, text: "" };
    if (type === "pin") return { ...base, title: "", description: "" };
    return {
      ...base,
      question: "What condition does this point to?",
      options: ["Rot", "Bite mark", "Healthy apple"],
      answer: "Rot",
    };
  }

  function createGhost(type) {
    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.textContent = TYPE_LABELS[type];
    document.body.appendChild(ghost);
    return ghost;
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
      if (!dragging && Math.hypot(e.clientX - startX, e.clientY - startY) > 10) {
        dragging = true;
        setArmed(null);
        ghost = createGhost(type);
      }
      if (!dragging) return;
      ghost.style.left = `${e.clientX}px`;
      ghost.style.top = `${e.clientY}px`;
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
      const rect = stage.getBoundingClientRect();
      if (state.drawing) {
        state.drawing.points.push({
          x: clamp((e.clientX - rect.left) / rect.width, 0, 1),
          y: clamp((e.clientY - rect.top) / rect.height, 0, 1),
        });
        const ann = findAnn(state.drawing.annId);
        if (ann) rebuildZoneControls(ann);
        renderToleranceOverlay();
        return;
      }
      if (state.armedType) {
        if (e.target.closest(".marker")) return;
        placeAnnotation(state.armedType, e.clientX, e.clientY, rect);
        setArmed(null);
        return;
      }
      if (state.selectedId && !e.target.closest(".marker")) deselectAnnotation();
    });
  }

  // --- lists ------------------------------------------------------------------------------

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
        ${isMultiSlice(ann) ? `<span class="slice-tag" title="Spans slices ${rangeLabel(ann)}">#${rangeLabel(ann)}</span>` : ""}
        <span class="layer-tag">${escapeHtml(ann.layer || "—")}</span>`;
      li.addEventListener("click", () => selectAnnotation(ann.id));
      annotationListEl.appendChild(li);
    });
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
        <span class="slice-tag">#${rangeLabel(ann)}</span>`;
      li.addEventListener("click", () => navigateToAnnotation(ann.id));
      allAnnotationListEl.appendChild(li);
    });
  }

  // --- inspector ----------------------------------------------------------------------------

  function typeFieldsMarkup(ann) {
    if (ann.type === "label") {
      return `
        <label>Label text
          <input type="text" id="f-text" maxlength="80" value="${escapeHtml(ann.text || "")}" placeholder="e.g. Core" />
        </label>`;
    }
    if (ann.type === "pin") {
      return `
        <label>Title
          <input type="text" id="f-title" maxlength="120" value="${escapeHtml(ann.title || "")}" placeholder="e.g. Seed chamber" />
        </label>
        <label>Description
          <textarea id="f-desc" placeholder="Longer explanation for students">${escapeHtml(ann.description || "")}</textarea>
        </label>`;
    }
    return `
      <label>Question
        <input type="text" id="f-question" maxlength="500" value="${escapeHtml(ann.question || "")}" />
      </label>
      <label>Options (one per line)
        <textarea id="f-options">${escapeHtml((ann.options || []).join("\n"))}</textarea>
      </label>
      <label>Correct answer
        <select id="f-answer"></select>
      </label>`;
  }

  function rangeSectionMarkup(ann) {
    const max = state.manifest.sliceCount;
    return `
      <div class="inspector-section" id="rangeSection">
        <h3 class="section-title">Slices</h3>
        <div class="row">
          <label>From <input type="number" id="f-from" min="1" max="${max}" value="${ann.sliceFrom}" /></label>
          <label>To <input type="number" id="f-to" min="1" max="${max}" value="${ann.sliceTo}" /></label>
          ${isMultiSlice(ann) ? `<button type="button" id="singleSliceBtn">This slice only</button>` : ""}
        </div>
        <p class="hint">A feature that runs through several slices can be set to appear on all of them. The zone is shared unless you adjust it on a particular slice.</p>
      </div>`;
  }

  function zoneControlsMarkup(ann) {
    const zone = viewZone(ann);
    const t = zone.tolerance;
    let scopeMarkup = "";
    if (isMultiSlice(ann)) {
      const adjusted = Object.keys(ann.overrides).map(Number).sort((a, b) => a - b);
      const hereAdjusted = hasOverride(ann, state.currentIndex);
      scopeMarkup = `
        <div class="row" role="radiogroup" aria-label="Edit zone on">
          <label><input type="radio" name="editScope" value="all" ${state.editScope === "all" ? "checked" : ""} /> All slices ${rangeLabel(ann)}</label>
          <label><input type="radio" name="editScope" value="slice" ${state.editScope === "slice" ? "checked" : ""} /> Slice ${state.currentIndex} only</label>
        </div>
        ${hereAdjusted ? `<div class="row"><span class="hint" style="margin:0">Slice ${state.currentIndex} has its own zone.</span><button type="button" id="resetOverrideBtn">Reset to shared zone</button></div>` : ""}
        ${adjusted.length ? `<div><span class="hint">Adjusted on:</span><ul class="adjusted-list">${adjusted.map((i) => `<li><button type="button" class="goto-slice${i === state.currentIndex ? " current" : ""}" data-slice="${i}">${i}</button></li>`).join("")}</ul></div>` : ""}`;
    }

    let shapeMarkup;
    if (t.mode !== "polygon") {
      const pct = Math.round((t.radius ?? DEFAULT_TOLERANCE.radius) * 100);
      shapeMarkup = `
        <label>Radius <span id="radiusReadout">${pct}%</span>
          <input type="range" id="f-radius" min="2" max="30" step="1" value="${pct}" />
        </label>
        <p class="hint">Students must place their answer within this circle of the slice to be marked correct.</p>`;
    } else {
      const drawing = state.drawing && state.drawing.annId === ann.id;
      const hasPolygon = t.polygon && t.polygon.length >= 3;
      if (drawing) {
        const n = state.drawing.points.length;
        shapeMarkup = `
          <p class="hint drawing">Click on the slice to add points (${n} so far, need at least 3).</p>
          <div class="btn-row">
            <button type="button" id="undoPointBtn" ${n === 0 ? "disabled" : ""}>Undo point</button>
            <button type="button" id="finishShapeBtn" ${n < 3 ? "disabled" : ""}>Finish shape</button>
            <button type="button" id="cancelDrawBtn">Cancel</button>
          </div>`;
      } else {
        shapeMarkup = `
          <p class="hint">${hasPolygon ? `Custom shape with ${t.polygon.length} points.` : "No custom shape yet — it doesn't need to surround the pin."}</p>
          <div class="btn-row"><button type="button" id="drawShapeBtn">${hasPolygon ? "Redraw shape" : "Draw shape"}</button></div>`;
      }
    }

    return `
      ${scopeMarkup}
      <div class="row" role="radiogroup" aria-label="Zone shape">
        <label><input type="radio" name="tolMode" value="radius" ${t.mode !== "polygon" ? "checked" : ""} /> Radius</label>
        <label><input type="radio" name="tolMode" value="polygon" ${t.mode === "polygon" ? "checked" : ""} /> Custom shape</label>
      </div>
      ${shapeMarkup}`;
  }

  function buildInspectorMarkup(ann) {
    return `
      <div class="inspector-header">
        <h2>${TYPE_LABELS[ann.type]}</h2>
        <button type="button" id="closeInspector" title="Close" aria-label="Close">×</button>
      </div>
      <p class="meta">Slice${isMultiSlice(ann) ? "s" : ""} ${rangeLabel(ann)} · layer: ${escapeHtml(ann.layer || "unassigned")}</p>
      ${typeFieldsMarkup(ann)}
      ${rangeSectionMarkup(ann)}
      <div class="inspector-section">
        <h3 class="section-title">Acceptable zone</h3>
        <div id="zoneControls">${zoneControlsMarkup(ann)}</div>
      </div>
      <div class="inspector-section inspector-actions">
        <button type="button" id="deleteBtn" class="danger">Delete</button>
      </div>`;
  }

  function afterFieldChange() {
    persist();
    renderMarkers();
    renderAnnotationList();
    renderGlobalList();
  }

  function rebuildZoneControls(ann) {
    const host = el("zoneControls");
    if (!host) return;
    host.innerHTML = zoneControlsMarkup(ann);
    bindZoneControls(ann);
  }

  function bindZoneControls(ann) {
    document.querySelectorAll('input[name="editScope"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        cancelDrawing();
        state.editScope = radio.value;
        rebuildZoneControls(ann);
        renderToleranceOverlay();
      });
    });
    const resetBtn = el("resetOverrideBtn");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        delete ann.overrides[state.currentIndex];
        persist();
        renderAll();
      });
    }
    document.querySelectorAll(".goto-slice").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const idx = Number(btn.dataset.slice);
        state.editScope = "slice";
        await loadSlice(idx);
      });
    });

    document.querySelectorAll('input[name="tolMode"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        const target = editTarget(ann);
        target.tolerance.mode = radio.value;
        persist();
        rebuildZoneControls(ann);
        renderToleranceOverlay();
      });
    });

    const slider = el("f-radius");
    if (slider) {
      const readoutEl = el("radiusReadout");
      slider.addEventListener("input", () => {
        const target = editTarget(ann);
        target.tolerance.radius = Number(slider.value) / 100;
        readoutEl.textContent = `${slider.value}%`;
        persist();
        renderMarkers();
        renderToleranceOverlay();
      });
    }
    const drawBtn = el("drawShapeBtn");
    if (drawBtn) {
      drawBtn.addEventListener("click", () => {
        state.drawing = { annId: ann.id, points: [] };
        stage.classList.add("drawing-mode");
        rebuildZoneControls(ann);
        renderToleranceOverlay();
      });
    }
    const undoBtn = el("undoPointBtn");
    if (undoBtn) {
      undoBtn.addEventListener("click", () => {
        state.drawing.points.pop();
        rebuildZoneControls(ann);
        renderToleranceOverlay();
      });
    }
    const finishBtn = el("finishShapeBtn");
    if (finishBtn) {
      finishBtn.addEventListener("click", () => {
        const target = editTarget(ann);
        target.tolerance.polygon = state.drawing.points.slice();
        target.tolerance.mode = "polygon";
        state.drawing = null;
        stage.classList.remove("drawing-mode");
        persist();
        renderAll();
      });
    }
    const cancelBtn = el("cancelDrawBtn");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => {
        cancelDrawing();
        rebuildZoneControls(ann);
        renderToleranceOverlay();
      });
    }
  }

  function wireInspector(ann) {
    el("closeInspector").addEventListener("click", deselectAnnotation);
    el("deleteBtn").addEventListener("click", () => {
      state.annotations = state.annotations.filter((a) => a.id !== ann.id);
      persist();
      deselectAnnotation();
      renderAll();
    });

    if (ann.type === "label") {
      el("f-text").addEventListener("input", (e) => { ann.text = e.target.value; afterFieldChange(); });
    } else if (ann.type === "pin") {
      el("f-title").addEventListener("input", (e) => { ann.title = e.target.value; afterFieldChange(); });
      el("f-desc").addEventListener("input", (e) => { ann.description = e.target.value; afterFieldChange(); });
    } else {
      el("f-question").addEventListener("input", (e) => { ann.question = e.target.value; afterFieldChange(); });
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
      answerSel.addEventListener("change", () => { ann.answer = answerSel.value; afterFieldChange(); });
    }

    const fromEl = el("f-from");
    const toEl = el("f-to");
    const applyRange = () => {
      setRange(ann, Number(fromEl.value), Number(toEl.value));
      persist();
      renderAll();
    };
    fromEl.addEventListener("change", applyRange);
    toEl.addEventListener("change", applyRange);
    const singleBtn = el("singleSliceBtn");
    if (singleBtn) {
      singleBtn.addEventListener("click", () => {
        const here = appliesToSlice(ann, state.currentIndex) ? state.currentIndex : ann.sliceFrom;
        const keep = zoneFor(ann, here);
        ann.x = keep.x;
        ann.y = keep.y;
        ann.tolerance = JSON.parse(JSON.stringify(keep.tolerance));
        ann.overrides = {};
        setRange(ann, here, here);
        persist();
        renderAll();
      });
    }

    bindZoneControls(ann);
  }

  function renderInspector() {
    const ann = findAnn(state.selectedId);
    if (!ann) {
      inspectorEl.dataset.annId = "";
      inspectorEl.dataset.signature = "";
      inspectorEl.innerHTML = `<p class="hint placeholder">Select an annotation on the slice, or drag a new one from the palette, to edit it here.</p>`;
      return;
    }
    // Rebuilding the inspector while typing would steal focus; only rebuild
    // when the selected annotation changed or when the structure must change.
    const sameAnn = inspectorEl.dataset.annId === ann.id;
    const signature = `${ann.id}|${ann.sliceFrom}|${ann.sliceTo}|${state.currentIndex}|${state.editScope}|${Object.keys(ann.overrides).join(",")}|${viewZone(ann).tolerance.mode}|${state.drawing ? "d" : ""}`;
    if (sameAnn && inspectorEl.dataset.signature === signature && document.activeElement && inspectorEl.contains(document.activeElement)) return;
    inspectorEl.dataset.annId = ann.id;
    inspectorEl.dataset.signature = signature;
    inspectorEl.innerHTML = buildInspectorMarkup(ann);
    wireInspector(ann);
  }

  // --- export -----------------------------------------------------------------------------------

  function downloadAnnotations(exportMode, quizMode) {
    const payload = S.buildExport({ manifest: state.manifest, annotations: state.annotations, exportMode, quizMode });
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "annotations.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function openExportModal() {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop open";
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="exportTitle">
        <h3 id="exportTitle">Export annotations</h3>
        <fieldset>
          <legend>What are you exporting this for?</legend>
          <label><input type="radio" name="exportMode" value="quiz" checked />
            <span><strong>Quiz</strong><br /><em>Students place features themselves and get checked.</em></span>
          </label>
          <label><input type="radio" name="exportMode" value="showcase" />
            <span><strong>Showcase</strong><br /><em>Read-only walkthrough of the annotated slices.</em></span>
          </label>
        </fieldset>
        <fieldset id="quizModeFieldset">
          <legend>How much should students be told?</legend>
          <label><input type="radio" name="quizMode" value="full" checked />
            <span><strong>Full challenge</strong><br /><em>Find the right slice and the right spot. Slice hints appear only after a miss.</em></span>
          </label>
          <label><input type="radio" name="quizMode" value="guided" />
            <span><strong>Guided</strong><br /><em>Shown which slices each feature is on from the start; only the spot is tested.</em></span>
          </label>
        </fieldset>
        <p class="hint">${state.manifest.datasetHash ? "The export carries this image stack's fingerprint, so the quiz can warn if the images change." : "This image stack has no fingerprint; the export can't be checked against it later."}</p>
        <div class="modal-actions">
          <button type="button" id="exportCancelBtn">Cancel</button>
          <button type="button" id="exportDownloadBtn" class="primary">Download</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const quizModeFieldset = backdrop.querySelector("#quizModeFieldset");
    backdrop.querySelectorAll('input[name="exportMode"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        if (radio.checked) quizModeFieldset.style.display = radio.value === "quiz" ? "" : "none";
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
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
    document.addEventListener("keydown", onKey);
    backdrop.querySelector("#exportDownloadBtn").addEventListener("click", () => {
      const exportMode = backdrop.querySelector('input[name="exportMode"]:checked').value;
      const quizMode = backdrop.querySelector('input[name="quizMode"]:checked').value;
      downloadAnnotations(exportMode, exportMode === "quiz" ? quizMode : undefined);
      close();
    });
  }

  // --- import -----------------------------------------------------------------------------------

  async function importAnnotationsFile(file) {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (err) {
      S.notify("error", `Could not import ${file.name}: the file is not valid JSON.`, { id: "import" });
      return;
    }
    const parsed = S.parseExportFile(data, state.manifest.sliceCount);
    if (parsed.error) {
      S.notify("error", `Could not import ${file.name}: ${parsed.error}.`, { id: "import" });
      return;
    }
    const imported = parsed.file;

    const check = S.compareDataset(imported, state.manifest);
    if (check.status !== "match") {
      const ok = await S.confirmDialog({
        title: check.status === "mismatch" ? "This file may be for a different image stack" : "This file can't be verified",
        message: `${check.message} Import it anyway?`,
        confirmLabel: "Import anyway",
        danger: check.status === "mismatch",
      });
      if (!ok) return;
    }
    if (state.annotations.length) {
      const ok = await S.confirmDialog({
        title: "Replace current annotations?",
        message: `Importing replaces the ${state.annotations.length} annotation${state.annotations.length === 1 ? "" : "s"} currently loaded.`,
        confirmLabel: "Replace",
        danger: true,
      });
      if (!ok) return;
    }

    state.annotations = imported.annotations;
    deselectAnnotation();
    persist();
    renderAll();
    S.dismissNotice("import");
    if (imported.rejected.length) {
      S.notify("warn", `Imported ${imported.annotations.length} annotations; ${imported.rejected.length} entr${imported.rejected.length === 1 ? "y was" : "ies were"} skipped (${S.describeRejected(imported.rejected)}).`, { id: "import" });
    } else if (imported.version < S.SCHEMA_VERSION) {
      S.notify("info", `Imported ${imported.annotations.length} annotations from an older export format; they will be saved in the current format.`, { id: "import" });
    }
  }

  // --- global wiring -----------------------------------------------------------------------------

  function wireGlobalControls() {
    wirePalette();

    scrub.addEventListener("input", () => {
      state.player.stop();
      loadSlice(Number(scrub.value));
    });
    playBtn.addEventListener("click", () => state.player.toggle());
    sortOrderEl.addEventListener("change", renderGlobalList);
    exportBtn.addEventListener("click", openExportModal);
    importBtn.addEventListener("click", () => importFile.click());
    importFile.addEventListener("change", async () => {
      const file = importFile.files[0];
      if (file) await importAnnotationsFile(file);
      importFile.value = "";
    });

    clearBtn.addEventListener("click", async () => {
      if (!state.annotations.length) return;
      const ok = await S.confirmDialog({
        title: "Delete all annotations?",
        message: "This removes every annotation on every slice. It cannot be undone.",
        confirmLabel: "Delete all",
        danger: true,
      });
      if (!ok) return;
      state.annotations = [];
      deselectAnnotation();
      persist();
      renderAll();
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
