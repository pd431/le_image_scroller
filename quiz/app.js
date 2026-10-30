(() => {
  const MANIFEST_URL = "../data/slices/manifest.json";
  const SLICE_URL = (filename) => `../data/slices/${encodeURIComponent(filename)}`;
  const isSvgFilename = (filename) => /\.svg$/i.test(filename);
  const DEFAULT_EXPORT_URL = "annotations.json";
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
  const hintTicksEl = el("hintTicks");
  const mineTicksEl = el("mineTicks");
  const importBtn = el("importBtn");
  const importFile = el("importFile");
  const inspectorEl = el("inspector");

  const showcaseSection = el("showcaseSection");
  const showcaseListEl = el("showcaseList");
  const totalAnnCountEl = el("totalAnnCount");
  const sortOrderEl = el("sortOrder");

  const quizSection = el("quizSection");
  const targetsListEl = el("targetsList");
  const targetsCountEl = el("targetsCount");
  const modeHintEl = el("modeHint");

  const checkSection = el("checkSection");
  const checkBtn = el("checkBtn");
  const resetBtn = el("resetBtn");
  const scoreSummaryEl = el("scoreSummary");

  const state = {
    manifest: null,
    quiz: null, // { exportMode, quizMode, dataset, annotations }
    targets: [], // quiz mode: annotations + studentAnswer/studentChoice/outcome
    currentIndex: 1,
    selectedId: null,
    armedId: null,
    checked: false,
    playing: false,
    playTimer: null,
  };

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function isPointInRect(x, y, rect) {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  // --- loading -------------------------------------------------------------

  async function init() {
    const manifestRes = await fetch(MANIFEST_URL);
    state.manifest = await manifestRes.json();
    toleranceLayer.setAttribute("viewBox", `0 0 ${state.manifest.size} ${state.manifest.size}`);
    scrub.max = state.manifest.sliceCount;

    let quiz = null;
    try {
      const res = await fetch(DEFAULT_EXPORT_URL);
      if (res.ok) quiz = await res.json();
    } catch {
      /* no bundled export - fine, the student can Import one */
    }

    wireGlobalControls();

    if (quiz) {
      await loadQuizData(quiz);
    } else {
      datasetInfo.textContent = "No annotation file loaded";
      inspectorEl.innerHTML = `<p class="hint placeholder">No annotations.json found next to this page. Use Import… to load one exported from the annotator.</p>`;
    }
  }

  function isValidQuizFile(data) {
    return data && Array.isArray(data.annotations) && (data.exportMode === "quiz" || data.exportMode === "showcase");
  }

  async function loadQuizData(data) {
    state.quiz = data;
    state.targets = data.annotations.map((a) => ({
      ...a,
      tolerance: a.tolerance || { ...DEFAULT_TOLERANCE },
      studentAnswer: null,
      studentChoice: null,
      outcome: null,
    }));
    state.selectedId = null;
    state.armedId = null;
    state.checked = false;

    const modeLabel = data.exportMode === "quiz"
      ? `Quiz · ${data.quizMode === "guided" ? "guided" : "full challenge"}`
      : "Showcase";
    datasetInfo.textContent = `${modeLabel} · ${state.targets.length} annotation${state.targets.length === 1 ? "" : "s"}`;

    showcaseSection.hidden = data.exportMode !== "showcase";
    quizSection.hidden = data.exportMode !== "quiz";
    checkSection.hidden = data.exportMode !== "quiz";
    resetBtn.hidden = true;
    scoreSummaryEl.textContent = "";

    if (data.exportMode === "quiz") {
      const base = data.quizMode === "guided"
        ? "Tap an item, then tap the slice where you think it belongs. Small markers on the slider below show which slice each item is on."
        : "Tap an item, then tap the slice where you think it belongs — you'll need to find the right slice yourself.";
      modeHintEl.textContent = `${base} MCQ items are already placed for you — just open one and choose an answer.`;
    }

    await loadSlice(1);
    renderShowcaseList();
    renderTargetsList();
    renderTicks();
  }

  // SVGs are fetched and injected inline so their shapes are real DOM
  // elements; any other image format (a real scan export - PNG/JPG/etc.)
  // is just rendered as a plain <img>.
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
    if (state.selectedId) {
      const sel = state.targets.find((t) => t.id === state.selectedId);
      const stillRelevant = sel && (
        (state.quiz.exportMode === "showcase" && sel.sliceIndex === index) ||
        (state.quiz.exportMode === "quiz" && sel.studentAnswer && sel.studentAnswer.sliceIndex === index)
      );
      if (!stillRelevant && state.quiz.exportMode === "showcase") state.selectedId = null;
    }

    const filename = state.manifest.files[index - 1];
    await loadSliceImage(filename);
    scrub.value = index;
    readout.textContent = `${index} / ${state.manifest.sliceCount}`;

    renderMarkers();
    renderToleranceOverlay();
    renderInspector();
  }

  function stopPlaying() {
    state.playing = false;
    playBtn.textContent = "Play";
    clearInterval(state.playTimer);
  }

  // --- grading ---------------------------------------------------------------

  function pointInPolygon(x, y, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].x, yi = polygon[i].y;
      const xj = polygon[j].x, yj = polygon[j].y;
      const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function isWithinTolerance(t, x, y) {
    const tol = t.tolerance || DEFAULT_TOLERANCE;
    if (tol.mode === "polygon" && tol.polygon && tol.polygon.length >= 3) {
      return pointInPolygon(x, y, tol.polygon);
    }
    const r = tol.radius ?? DEFAULT_TOLERANCE.radius;
    return Math.hypot(x - t.x, y - t.y) <= r;
  }

  function isAttempted(t) {
    return !!t.studentAnswer || (t.type === "mcq" && !!t.studentChoice);
  }

  function checkAnswers() {
    state.targets.forEach((t) => {
      if (!isAttempted(t)) {
        t.outcome = null;
        return;
      }
      if (t.type === "mcq") {
        // MCQs are always shown at their true spot (see renderMarkers) -
        // the question is about identifying the condition, not finding the
        // point, so only the chosen answer is graded.
        t.outcome = t.studentChoice === t.answer ? "correct" : "incorrect";
        return;
      }
      const posOk = !!t.studentAnswer &&
        t.studentAnswer.sliceIndex === t.sliceIndex &&
        isWithinTolerance(t, t.studentAnswer.x, t.studentAnswer.y);
      t.outcome = posOk ? "correct" : "incorrect";
    });
    state.checked = true;
    resetBtn.hidden = false;
    renderScoreSummary();
    renderTargetsList();
    renderMarkers();
    renderToleranceOverlay();
    renderInspector();
  }

  function resetAttempt() {
    state.targets.forEach((t) => {
      t.studentAnswer = null;
      t.studentChoice = null;
      t.outcome = null;
    });
    state.checked = false;
    state.selectedId = null;
    state.armedId = null;
    resetBtn.hidden = true;
    scoreSummaryEl.textContent = "";
    stage.classList.remove("armed-mode");
    renderTargetsList();
    renderTicks();
    renderMarkers();
    renderToleranceOverlay();
    renderInspector();
  }

  function renderScoreSummary() {
    const total = state.targets.length;
    const correct = state.targets.filter((t) => t.outcome === "correct").length;
    const attempted = state.targets.filter((t) => isAttempted(t)).length;
    const allCorrect = correct === total && total > 0;
    scoreSummaryEl.innerHTML = `<span class="tally${allCorrect ? " all-correct" : ""}">${correct} / ${total}</span> correct` +
      (attempted < total ? ` · ${total - attempted} not attempted` : "");
  }

  // --- ticks (slider hints) ---------------------------------------------------

  function renderTicks() {
    hintTicksEl.innerHTML = "";
    mineTicksEl.innerHTML = "";
    if (!state.quiz || state.quiz.exportMode !== "quiz") return;

    const count = state.manifest.sliceCount;
    const fracFor = (idx) => (count > 1 ? (idx - 1) / (count - 1) : 0);
    const guided = state.quiz.quizMode === "guided";

    // MCQs are always shown at their true slice (the question is about the
    // spot, not finding it), so their hint always shows; label/pin hints
    // only show in guided exports.
    state.targets.forEach((t) => {
      if (t.type !== "mcq" && !guided) return;
      const tick = document.createElement("div");
      tick.className = "tick" + (t.id === state.selectedId ? " active" : "");
      tick.style.left = `${fracFor(t.sliceIndex) * 100}%`;
      hintTicksEl.appendChild(tick);
    });

    const placedSlices = new Set(state.targets.filter((t) => t.type !== "mcq" && t.studentAnswer).map((t) => t.studentAnswer.sliceIndex));
    placedSlices.forEach((idx) => {
      const tick = document.createElement("div");
      tick.className = "tick";
      tick.style.left = `${fracFor(idx) * 100}%`;
      mineTicksEl.appendChild(tick);
    });
  }

  // --- markers -----------------------------------------------------------------

  function toleranceShapeMarkup(t, size, isSelected) {
    const tol = t.tolerance || DEFAULT_TOLERANCE;
    const cls = isSelected ? "tolerance selected" : "tolerance";
    if (tol.mode === "polygon" && tol.polygon && tol.polygon.length >= 3) {
      const pts = tol.polygon.map((p) => `${(p.x * size).toFixed(1)},${(p.y * size).toFixed(1)}`).join(" ");
      return `<polygon class="${cls}" points="${pts}" />`;
    }
    const r = (tol.radius ?? DEFAULT_TOLERANCE.radius) * size;
    return `<circle class="${cls}" cx="${(t.x * size).toFixed(1)}" cy="${(t.y * size).toFixed(1)}" r="${r.toFixed(1)}" />`;
  }

  function renderToleranceOverlay() {
    if (!state.quiz) return;
    const size = state.manifest.size;
    const parts = [];

    if (state.quiz.exportMode === "quiz" && state.checked) {
      state.targets.forEach((t) => {
        // MCQs are always shown at their true spot (see renderMarkers) -
        // no separate reveal/tolerance zone needed for them.
        if (t.type === "mcq" || t.sliceIndex !== state.currentIndex) return;
        parts.push(toleranceShapeMarkup(t, size, t.id === state.selectedId));
        parts.push(`<circle class="reveal-dot" cx="${(t.x * size).toFixed(1)}" cy="${(t.y * size).toFixed(1)}" r="5" />`);
      });
    }

    toleranceLayer.innerHTML = parts.join("");
  }

  function iconHtmlFor(type, extraClass) {
    const cls = extraClass ? ` ${extraClass}` : "";
    if (type === "label") return `<span class="icon label${cls}"></span>`;
    if (type === "pin") return `<span class="icon pin${cls}">i</span>`;
    return `<span class="icon mcq${cls}">?</span>`;
  }

  function renderMarkers() {
    markerLayer.innerHTML = "";
    if (!state.quiz) return;

    if (state.quiz.exportMode === "showcase") {
      state.targets.filter((t) => t.sliceIndex === state.currentIndex).forEach((t) => {
        markerLayer.appendChild(buildShowcaseMarkerEl(t));
      });
      return;
    }

    state.targets.forEach((t) => {
      // MCQs ask about a specific spot rather than testing whether the
      // student can find it, so they're always shown at their true
      // location/slice - the student's job is just to pick the right
      // answer, not to place a marker.
      if (t.type === "mcq") {
        if (t.sliceIndex === state.currentIndex) markerLayer.appendChild(buildMcqMarkerEl(t));
        return;
      }
      if (t.studentAnswer && t.studentAnswer.sliceIndex === state.currentIndex) {
        markerLayer.appendChild(buildGuessMarkerEl(t));
      }
    });
  }

  function buildMcqMarkerEl(t) {
    const div = document.createElement("div");
    const outcomeCls = t.outcome ? ` outcome-${t.outcome}` : t.studentChoice ? " outcome-pending" : "";
    div.className = `marker mcq-fixed${outcomeCls}` + (t.id === state.selectedId ? " selected" : "");
    div.style.left = `${t.x * 100}%`;
    div.style.top = `${t.y * 100}%`;
    div.title = t.question || "MCQ";
    div.innerHTML = `<span class="icon-circle">?</span>`;
    div.addEventListener("click", (e) => {
      e.stopPropagation();
      selectTarget(t.id);
    });
    return div;
  }

  function buildShowcaseMarkerEl(t) {
    const div = document.createElement("div");
    div.className = `marker showcase ${t.type}` + (t.id === state.selectedId ? " selected" : "");
    div.style.left = `${t.x * 100}%`;
    div.style.top = `${t.y * 100}%`;
    if (t.type === "label") {
      div.innerHTML = `<span class="dot"></span><span class="chip">${escapeHtml(t.text || "")}</span>`;
    } else if (t.type === "pin") {
      div.title = t.title || "Pin";
      div.innerHTML = `<span class="icon-circle">i</span>`;
    } else {
      div.title = t.question || "MCQ";
      div.innerHTML = `<span class="icon-circle">?</span>`;
    }
    div.addEventListener("click", (e) => {
      e.stopPropagation();
      selectTarget(t.id);
    });
    return div;
  }

  function buildGuessMarkerEl(t) {
    const div = document.createElement("div");
    const outcomeCls = t.outcome ? ` outcome-${t.outcome}` : "";
    div.className = `marker mine ${t.type}${outcomeCls}` + (t.id === state.selectedId ? " selected" : "");
    div.style.left = `${t.studentAnswer.x * 100}%`;
    div.style.top = `${t.studentAnswer.y * 100}%`;
    if (t.type === "label") {
      div.innerHTML = `<span class="dot"></span><span class="chip">${escapeHtml(t.text || "")}</span>`;
    } else {
      div.innerHTML = `<span class="icon-circle">${t.type === "mcq" ? "?" : "i"}</span>`;
    }
    wireGuessDrag(div, t);
    return div;
  }

  function wireGuessDrag(div, t) {
    div.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      div.setPointerCapture(e.pointerId);
      let dragging = false;
      let pendingX = t.studentAnswer.x;
      let pendingY = t.studentAnswer.y;
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

      const onUp = () => {
        div.removeEventListener("pointermove", onMove);
        if (dragging) {
          t.studentAnswer.x = pendingX;
          t.studentAnswer.y = pendingY;
          t.outcome = null;
          renderTicks();
          renderTargetsList();
          renderInspector();
          renderMarkers();
          renderToleranceOverlay();
        } else {
          selectTarget(t.id);
        }
      };

      div.addEventListener("pointermove", onMove);
      div.addEventListener("pointerup", onUp, { once: true });
    });
  }

  // --- showcase list -------------------------------------------------------

  function summaryFor(t) {
    if (t.type === "label") return t.text || "(empty label)";
    if (t.type === "pin") return t.title || "(untitled pin)";
    return t.question || "(untitled question)";
  }

  function sortAnnotations(list, order) {
    const copy = list.slice();
    if (order === "type") return copy.sort((a, b) => TYPE_LABELS[a.type].localeCompare(TYPE_LABELS[b.type]) || a.sliceIndex - b.sliceIndex);
    if (order === "title-asc") return copy.sort((a, b) => summaryFor(a).localeCompare(summaryFor(b)));
    if (order === "title-desc") return copy.sort((a, b) => summaryFor(b).localeCompare(summaryFor(a)));
    return copy.sort((a, b) => a.sliceIndex - b.sliceIndex);
  }

  function renderShowcaseList() {
    if (!state.quiz || state.quiz.exportMode !== "showcase") return;
    totalAnnCountEl.textContent = state.targets.length;
    const sorted = sortAnnotations(state.targets, sortOrderEl.value);
    showcaseListEl.innerHTML = "";

    if (!sorted.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No annotations in this file.";
      showcaseListEl.appendChild(li);
      return;
    }

    sorted.forEach((t) => {
      const li = document.createElement("li");
      if (t.id === state.selectedId) li.classList.add("active");
      li.innerHTML = `
        ${iconHtmlFor(t.type)}
        <span class="label-text">${escapeHtml(summaryFor(t))}</span>
        <span class="slice-tag">#${t.sliceIndex}</span>
      `;
      li.addEventListener("click", () => navigateToShowcaseItem(t.id));
      showcaseListEl.appendChild(li);
    });
  }

  async function navigateToShowcaseItem(id) {
    const t = state.targets.find((x) => x.id === id);
    if (!t) return;
    stopPlaying();
    if (t.sliceIndex !== state.currentIndex) await loadSlice(t.sliceIndex);
    selectTarget(id);
  }

  // --- quiz targets list -----------------------------------------------------

  function statusClassFor(t) {
    if (t.outcome === "correct") return "correct";
    if (t.outcome === "incorrect") return "incorrect";
    if (isAttempted(t)) return "placed";
    return "unplaced";
  }

  function renderTargetsList() {
    if (!state.quiz || state.quiz.exportMode !== "quiz") return;
    targetsCountEl.textContent = state.targets.length;
    targetsListEl.innerHTML = "";

    state.targets.forEach((t) => {
      const li = document.createElement("li");
      li.dataset.id = t.id;
      if (t.id === state.selectedId) li.classList.add("active");
      if (t.id === state.armedId) li.classList.add("armed");
      li.innerHTML = `
        <span class="status-icon ${statusClassFor(t)}"></span>
        <span class="label-text">${escapeHtml(summaryFor(t))}</span>
      `;
      targetsListEl.appendChild(li);
    });
  }

  // Only reached for unplaced items (placed items navigate via the plain
  // "click" listener in wireGlobalControls instead) - a tap arms the item
  // for tap-to-place.
  function onTargetListClick(id) {
    setArmed(state.armedId === id ? null : id);
    selectTarget(id);
  }

  async function navigateToTarget(id) {
    const t = state.targets.find((x) => x.id === id);
    if (!t) return;
    stopPlaying();
    setArmed(null);
    // MCQs are always shown at their true slice; other types navigate to
    // wherever the student placed their guess (if anywhere).
    const targetSlice = t.type === "mcq" ? t.sliceIndex : t.studentAnswer && t.studentAnswer.sliceIndex;
    if (targetSlice && targetSlice !== state.currentIndex) {
      await loadSlice(targetSlice);
    }
    selectTarget(id);
  }

  // --- selection / arming ------------------------------------------------------

  function setArmed(id) {
    state.armedId = id;
    stage.classList.toggle("armed-mode", !!id);
    renderTargetsList();
  }

  function selectTarget(id) {
    state.selectedId = id;
    renderInspector();
    renderMarkers();
    renderToleranceOverlay();
    if (state.quiz.exportMode === "showcase") renderShowcaseList();
    else { renderTargetsList(); renderTicks(); }
  }

  function deselect() {
    if (!state.selectedId && !state.armedId) return;
    state.selectedId = null;
    setArmed(null);
    renderInspector();
    renderMarkers();
    renderToleranceOverlay();
    if (state.quiz && state.quiz.exportMode === "showcase") renderShowcaseList();
    else if (state.quiz) renderTicks();
  }

  function placeGuess(id, clientX, clientY, rect) {
    const t = state.targets.find((x) => x.id === id);
    if (!t) return;
    const x = clamp((clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((clientY - rect.top) / rect.height, 0, 1);
    t.studentAnswer = { sliceIndex: state.currentIndex, x, y };
    t.outcome = null;
    setArmed(null);
    selectTarget(id);
    renderTicks();
  }

  // --- inspector -----------------------------------------------------------

  function renderInspector() {
    if (!state.quiz) return;
    const t = state.targets.find((x) => x.id === state.selectedId);
    if (!t) {
      inspectorEl.innerHTML = state.quiz.exportMode === "showcase"
        ? `<p class="hint placeholder">Select an annotation to see its details.</p>`
        : `<p class="hint placeholder">Select an item on the left to see what to place, or tap a placed marker to review it.</p>`;
      return;
    }
    inspectorEl.innerHTML = state.quiz.exportMode === "showcase" ? buildShowcaseInspector(t) : buildQuizInspector(t);
    wireInspector(t);
  }

  function buildShowcaseInspector(t) {
    const header = `
      <div class="inspector-header"><h2>${TYPE_LABELS[t.type]}</h2><button id="closeInspector" title="Close">×</button></div>
      <p class="meta">Slice ${t.sliceIndex} · layer: ${escapeHtml(t.layer || "unassigned")}</p>`;
    if (t.type === "label") return `${header}<p class="prompt">${escapeHtml(t.text || "")}</p>`;
    if (t.type === "pin") {
      return `${header}<p class="prompt">${escapeHtml(t.title || "")}</p><p>${escapeHtml(t.description || "")}</p>`;
    }
    const options = (t.options || []).map((o) => `<li class="${o === t.answer ? "correct-answer" : ""}">${escapeHtml(o)}</li>`).join("");
    return `${header}<p class="prompt">${escapeHtml(t.question || "")}</p><ul class="options-list">${options}</ul>`;
  }

  function buildQuizInspector(t) {
    const header = `<div class="inspector-header"><h2>${TYPE_LABELS[t.type]}</h2><button id="closeInspector" title="Close">×</button></div>`;
    const prompt = `<p class="prompt">${escapeHtml(summaryFor(t))}</p>`;

    if (t.type === "mcq") {
      const opts = (t.options || []).map((o) => `<option value="${escapeHtml(o)}" ${o === t.studentChoice ? "selected" : ""}>${escapeHtml(o)}</option>`).join("");
      const mcqBlock = `<p class="meta">On slice ${t.sliceIndex} — already placed for you.</p>` +
        `<label>Your answer<select id="f-choice"><option value="">Choose…</option>${opts}</select></label>`;

      let outcomeBlock = "";
      if (state.checked) {
        const attempted = isAttempted(t);
        const cls = t.outcome === "correct" ? "correct" : attempted ? "incorrect" : "pending";
        const text = t.outcome === "correct" ? "Correct!" : attempted ? "Not quite" : "Not attempted";
        outcomeBlock = `<div class="outcome-banner ${cls}">${text}</div>`;
        if (attempted) {
          outcomeBlock += `<div class="reveal-section"><h3>Reveal</h3><p>Correct answer: <strong>${escapeHtml(t.answer || "")}</strong></p></div>`;
        }
      }
      return `${header}${prompt}${mcqBlock}${outcomeBlock}`;
    }

    let placementBlock;
    if (t.studentAnswer) {
      placementBlock = `<p class="meta">Your placement: slice ${t.studentAnswer.sliceIndex}</p><button id="clearPlacementBtn">Clear placement</button>`;
    } else {
      placementBlock = `<p class="hint">Tap the slice where you think this belongs.</p>`;
    }

    let outcomeBlock = "";
    if (state.checked) {
      const attempted = isAttempted(t);
      const cls = t.outcome === "correct" ? "correct" : attempted ? "incorrect" : "pending";
      const text = t.outcome === "correct" ? "Correct!" : attempted ? "Not quite" : "Not attempted";
      outcomeBlock = `<div class="outcome-banner ${cls}">${text}</div>`;
      if (attempted) {
        let reveal = `<p class="meta">Correct slice: ${t.sliceIndex}</p>`;
        if (t.type === "pin") reveal += `<p>${escapeHtml(t.description || "")}</p>`;
        outcomeBlock += `<div class="reveal-section"><h3>Reveal</h3>${reveal}</div>`;
      }
    }

    return `${header}${prompt}${placementBlock}${outcomeBlock}`;
  }

  function wireInspector(t) {
    el("closeInspector").addEventListener("click", deselect);

    const choiceSel = el("f-choice");
    if (choiceSel) {
      choiceSel.addEventListener("change", () => {
        t.studentChoice = choiceSel.value || null;
        t.outcome = null;
        renderTargetsList();
        renderMarkers();
      });
    }

    const clearBtn = el("clearPlacementBtn");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        t.studentAnswer = null;
        t.outcome = null;
        renderTargetsList();
        renderTicks();
        renderMarkers();
        renderToleranceOverlay();
        renderInspector();
      });
    }
  }

  // --- placement interaction: drag from list, or tap-to-arm/tap-to-place -----

  function createGhost(text) {
    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.textContent = text;
    document.body.appendChild(ghost);
    return ghost;
  }

  function positionGhost(ghost, x, y) {
    ghost.style.left = `${x}px`;
    ghost.style.top = `${y}px`;
  }

  function beginTargetInteraction(li, downEvent, t) {
    if (t.studentAnswer) return; // already placed - list click handles navigation instead
    const startX = downEvent.clientX;
    const startY = downEvent.clientY;
    let dragging = false;
    let ghost = null;

    li.setPointerCapture(downEvent.pointerId);

    const cleanup = () => {
      li.removeEventListener("pointermove", onMove);
      li.removeEventListener("pointerup", onUp);
      li.removeEventListener("pointercancel", onCancel);
      stage.classList.remove("drag-over");
      if (ghost) ghost.remove();
    };

    const onMove = (e) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) > 10) {
        dragging = true;
        ghost = createGhost(summaryFor(t));
      }
      if (!dragging) return;
      positionGhost(ghost, e.clientX, e.clientY);
      stage.classList.toggle("drag-over", isPointInRect(e.clientX, e.clientY, stage.getBoundingClientRect()));
    };

    const onUp = (e) => {
      cleanup();
      if (dragging) {
        const rect = stage.getBoundingClientRect();
        if (isPointInRect(e.clientX, e.clientY, rect)) placeGuess(t.id, e.clientX, e.clientY, rect);
      } else {
        onTargetListClick(t.id);
      }
    };
    const onCancel = () => cleanup();

    li.addEventListener("pointermove", onMove);
    li.addEventListener("pointerup", onUp);
    li.addEventListener("pointercancel", onCancel);
  }

  // --- global wiring -----------------------------------------------------------

  function wireGlobalControls() {
    scrub.addEventListener("input", () => {
      stopPlaying();
      loadSlice(Number(scrub.value)).then(renderTicks);
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
        loadSlice(next).then(renderTicks);
      }, 300);
    });

    stage.addEventListener("click", (e) => {
      if (!state.quiz || state.quiz.exportMode !== "quiz") return;
      if (state.armedId) {
        if (e.target.closest(".marker")) return;
        const rect = stage.getBoundingClientRect();
        placeGuess(state.armedId, e.clientX, e.clientY, rect);
        return;
      }
      if (state.selectedId && !e.target.closest(".marker")) deselect();
    });

    // MCQs and already-placed items just navigate on a plain click (no
    // drag needed - MCQs are always shown at their true spot, and
    // repositioning a placed guess happens via its marker on the stage
    // instead). Unplaced label/pin items go through the pointerdown-based
    // drag-or-arm interaction below; splitting on this avoids both
    // mechanisms firing for the same tap.
    targetsListEl.addEventListener("click", (e) => {
      const li = e.target.closest("li[data-id]");
      if (!li) return;
      const t = state.targets.find((x) => x.id === li.dataset.id);
      if (t && (t.type === "mcq" || t.studentAnswer)) navigateToTarget(t.id);
    });

    targetsListEl.addEventListener("pointerdown", (e) => {
      const li = e.target.closest("li[data-id]");
      if (!li) return;
      const t = state.targets.find((x) => x.id === li.dataset.id);
      if (!t || t.type === "mcq" || t.studentAnswer) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault();
      beginTargetInteraction(li, e, t);
    });

    sortOrderEl.addEventListener("change", renderShowcaseList);

    checkBtn.addEventListener("click", checkAnswers);
    resetBtn.addEventListener("click", resetAttempt);

    importBtn.addEventListener("click", () => importFile.click());
    importFile.addEventListener("change", async () => {
      const file = importFile.files[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        if (!isValidQuizFile(parsed)) throw new Error("Not a valid annotations export");
        await loadQuizData(parsed);
      } catch (err) {
        alert("Could not import file: " + err.message);
      } finally {
        importFile.value = "";
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (state.armedId) setArmed(null);
      else if (state.selectedId) deselect();
    });
  }

  init();
})();
