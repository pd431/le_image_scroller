(() => {
  "use strict";
  const S = window.Scanner;
  const {
    el, clamp, escapeHtml, TYPE_LABELS,
    appliesToSlice, isMultiSlice, zoneFor, rangeLabel, gradePlacement,
    summaryFor, iconHtmlFor, sortAnnotations, toleranceShapeMarkup, sliderFraction,
  } = S;

  const MANIFEST_URL = "../data/slices/manifest.json";
  const SLICE_URL = (filename) => `../data/slices/${encodeURIComponent(filename)}`;
  const DEFAULT_EXPORT_URL = "annotations.json";

  // How many misses before each level of help. Placement items get three
  // chances before "Show me" is offered; MCQs get two.
  const HINT_RANGE_AFTER = 1;
  const HINT_ZONE_AFTER = 2;
  const SHOW_ME_AFTER = { label: 3, pin: 3, mcq: 2 };

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
  const progressCountEl = el("progressCount");
  const modeHintEl = el("modeHint");
  const summaryBtn = el("summaryBtn");
  const restartBtn = el("restartBtn");

  const state = {
    manifest: null,
    loader: null,
    player: null,
    quiz: null, // parsed export file
    store: null,
    targets: [], // annotations + student state (see freshTarget)
    currentIndex: 1,
    phase: "start", // "start" | "item" | "summary"   (quiz exports only)
    currentId: null, // item being worked on (quiz) / selected (showcase)
  };

  // --- loading ------------------------------------------------------------------------

  async function init() {
    try {
      state.manifest = await S.loadManifest(MANIFEST_URL);
    } catch (err) {
      S.showFatal(err);
      return;
    }
    const m = state.manifest;
    state.loader = S.createSliceLoader({ host: svgHost, manifest: m, sliceUrl: SLICE_URL });
    state.player = S.createPlayer({
      button: playBtn,
      interval: 300,
      step: () => loadSlice(state.currentIndex >= m.sliceCount ? 1 : state.currentIndex + 1),
    });
    toleranceLayer.setAttribute("viewBox", `0 0 ${m.size} ${m.size}`);
    scrub.max = m.sliceCount;

    wireGlobalControls();

    let bundled = null;
    try {
      bundled = await S.fetchJson(DEFAULT_EXPORT_URL, "The bundled annotations file");
    } catch (err) {
      // No bundled export (or a broken one): the student can still import.
      if (!(err instanceof S.LoadError) || !/HTTP 404/.test(err.message)) {
        S.notify("warn", `${err.message} Use Import… to load an annotations file.`, { id: "load" });
      }
    }

    if (bundled) {
      const parsed = S.parseExportFile(bundled.data, m.sliceCount);
      if (parsed.error) {
        S.notify("error", `The bundled annotations.json can't be used: ${parsed.error}. Use Import… to load another file.`, { id: "load" });
        showEmpty();
      } else {
        await loadQuizData(parsed.file, bundled.text, "annotations.json");
      }
    } else {
      showEmpty();
    }
  }

  function showEmpty() {
    datasetInfo.textContent = "No annotation file loaded";
    inspectorEl.innerHTML = `<p class="hint placeholder">No annotations.json found next to this page. Use Import… to load one exported from the annotator.</p>`;
  }

  function freshTarget(ann) {
    return {
      ...ann,
      placement: null, // { sliceIndex, x, y }
      choice: null, // MCQ option text
      tries: 0, // number of checks that came back wrong
      status: "todo", // "todo" | "correct" | "revealed"
      skipped: false,
      lastResult: null, // { correct, reason } from the latest check
    };
  }

  async function loadQuizData(file, rawText, sourceName) {
    state.quiz = file;
    state.targets = file.annotations.map(freshTarget);
    state.currentId = null;
    state.phase = "start";

    const fileHash = S.sha256Hex(rawText || JSON.stringify(file));
    state.store = S.createStore(`quiz:${state.manifest.datasetHash || "unfingerprinted"}:${fileHash}:v3`);

    const check = S.compareDataset(file, state.manifest);
    if (check.status === "mismatch") {
      S.notify("warn", `${check.message} Markers may not line up with the images.`, { id: "dataset" });
    } else if (check.status === "unverified") {
      S.notify("info", check.message, { id: "dataset" });
    } else {
      S.dismissNotice("dataset");
    }
    if (file.rejected.length) {
      S.notify("warn", `${file.rejected.length} entr${file.rejected.length === 1 ? "y" : "ies"} in ${sourceName} could not be used (${S.describeRejected(file.rejected)}).`, { id: "rejected" });
    } else {
      S.dismissNotice("rejected");
    }

    const n = state.targets.length;
    const modeLabel = file.exportMode === "quiz"
      ? `Quiz · ${file.quizMode === "guided" ? "guided" : "full challenge"}`
      : "Showcase";
    datasetInfo.textContent = `${modeLabel} · ${n} item${n === 1 ? "" : "s"}`;

    showcaseSection.hidden = file.exportMode !== "showcase";
    quizSection.hidden = file.exportMode !== "quiz";

    if (file.exportMode === "quiz") {
      modeHintEl.textContent = file.quizMode === "guided"
        ? "You'll be shown which slices each feature is on; find the right spot."
        : "Find both the right slice and the right spot. Hints appear if you miss.";
      restoreProgress();
      if (!S.storageAvailable()) {
        S.notify("info", "This browser is blocking storage, so your progress won't survive a page reload.", { id: "storage" });
      }
    }

    await loadSlice(1);
    renderAll();
  }

  // --- progress persistence (quiz exports) ---------------------------------------------

  function saveProgress() {
    if (!state.store || !state.quiz || state.quiz.exportMode !== "quiz") return;
    const items = {};
    state.targets.forEach((t) => {
      items[t.id] = {
        placement: t.placement, choice: t.choice, tries: t.tries, status: t.status, skipped: t.skipped, lastResult: t.lastResult,
      };
    });
    state.store.write({ phase: state.phase, currentId: state.currentId, items });
  }

  function restoreProgress() {
    const saved = state.store.read();
    if (!saved || typeof saved !== "object" || !saved.items) return;
    let any = false;
    state.targets.forEach((t) => {
      const s = saved.items[t.id];
      if (!s || typeof s !== "object") return;
      any = true;
      const p = s.placement;
      t.placement = p && Number.isInteger(p.sliceIndex) && Number.isFinite(p.x) && Number.isFinite(p.y)
        ? { sliceIndex: clamp(p.sliceIndex, 1, state.manifest.sliceCount), x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) }
        : null;
      t.choice = typeof s.choice === "string" && (t.options || []).includes(s.choice) ? s.choice : null;
      t.tries = Number.isInteger(s.tries) && s.tries >= 0 ? s.tries : 0;
      t.status = ["todo", "correct", "revealed"].includes(s.status) ? s.status : "todo";
      t.skipped = !!s.skipped;
      t.lastResult = s.lastResult && typeof s.lastResult === "object" ? { correct: !!s.lastResult.correct, reason: String(s.lastResult.reason || "") } : null;
    });
    if (!any) return;
    state.phase = ["start", "item", "summary"].includes(saved.phase) ? saved.phase : "item";
    state.currentId = state.targets.some((t) => t.id === saved.currentId) ? saved.currentId : null;
    if (state.phase === "item" && !state.currentId) state.currentId = (nextTodo(null) || state.targets[0] || {}).id || null;
  }

  // --- slice navigation ------------------------------------------------------------------

  async function loadSlice(index) {
    index = clamp(index, 1, state.manifest.sliceCount);
    const shown = await state.loader.load(index);
    if (!shown) return;
    state.currentIndex = index;
    scrub.value = index;
    readout.textContent = `${index} / ${state.manifest.sliceCount}`;
    if (state.quiz && state.quiz.exportMode === "showcase" && state.currentId) {
      const sel = findTarget(state.currentId);
      if (!sel || !appliesToSlice(sel, index)) state.currentId = null;
    }
    renderStage();
    renderInspector();
    if (state.quiz && state.quiz.exportMode === "showcase") renderShowcaseList();
  }

  function findTarget(id) {
    return state.targets.find((t) => t.id === id);
  }

  function currentTarget() {
    return state.quiz && state.quiz.exportMode === "quiz" && state.phase === "item" ? findTarget(state.currentId) : null;
  }

  // --- quiz flow ---------------------------------------------------------------------------

  function isDone(t) {
    return t.status === "correct" || t.status === "revealed";
  }

  function nextTodo(afterId) {
    const start = afterId ? state.targets.findIndex((t) => t.id === afterId) + 1 : 0;
    for (let i = 0; i < state.targets.length; i++) {
      const t = state.targets[(start + i) % state.targets.length];
      if (!isDone(t)) return t;
    }
    return null;
  }

  function startQuiz() {
    state.phase = "item";
    goToItem((nextTodo(null) || state.targets[0]).id);
  }

  async function goToItem(id) {
    const t = findTarget(id);
    if (!t) return;
    state.player.stop();
    state.phase = "item";
    state.currentId = id;
    saveProgress();
    // Jump to where the student is working on it: their placement, or the
    // true slice for MCQs (always shown in place) and anything already solved.
    const target = t.type === "mcq" || isDone(t)
      ? (appliesToSlice(t, state.currentIndex) ? null : t.sliceFrom)
      : (t.placement ? t.placement.sliceIndex : null);
    if (target && target !== state.currentIndex) await loadSlice(target);
    renderAll();
  }

  function advance() {
    const next = nextTodo(state.currentId);
    if (next) goToItem(next.id);
    else showSummary();
  }

  function skipCurrent() {
    const t = currentTarget();
    if (!t) return;
    t.skipped = true;
    const next = nextTodo(t.id);
    if (next && next.id !== t.id) goToItem(next.id);
    else showSummary();
  }

  function showSummary() {
    state.phase = "summary";
    state.currentId = null;
    saveProgress();
    renderAll();
  }

  function hintLevel(t) {
    if (t.type === "mcq") return 0;
    if (state.quiz.quizMode === "guided") return Math.max(1, t.tries >= HINT_ZONE_AFTER ? 2 : 1);
    if (t.tries >= HINT_ZONE_AFTER) return 2;
    if (t.tries >= HINT_RANGE_AFTER) return 1;
    return 0;
  }

  function canShowMe(t) {
    return !isDone(t) && t.tries >= SHOW_ME_AFTER[t.type];
  }

  function checkCurrent() {
    const t = currentTarget();
    if (!t || isDone(t)) return;
    let result;
    if (t.type === "mcq") {
      if (!t.choice) return;
      result = { correct: t.choice === t.answer, reason: t.choice === t.answer ? "" : "choice" };
    } else {
      if (!t.placement) return;
      result = gradePlacement(t, t.placement);
    }
    t.lastResult = result;
    if (result.correct) t.status = "correct";
    else t.tries += 1;
    saveProgress();
    renderAll();
  }

  function revealCurrent() {
    const t = currentTarget();
    if (!t || !canShowMe(t)) return;
    t.status = "revealed";
    t.lastResult = null;
    saveProgress();
    if (!appliesToSlice(t, state.currentIndex)) loadSlice(t.sliceFrom).then(renderAll);
    else renderAll();
  }

  function retryItem(id) {
    const t = findTarget(id);
    if (!t) return;
    Object.assign(t, { placement: null, choice: null, tries: 0, status: "todo", skipped: false, lastResult: null });
    goToItem(id);
  }

  async function restartQuiz() {
    const ok = await S.confirmDialog({
      title: "Start over?",
      message: "This clears every placement and answer and starts the quiz again.",
      confirmLabel: "Start over",
      danger: true,
    });
    if (!ok) return;
    state.targets = state.quiz.annotations.map(freshTarget);
    state.phase = "start";
    state.currentId = null;
    saveProgress();
    renderAll();
  }

  function placeCurrent(clientX, clientY, rect) {
    const t = currentTarget();
    if (!t || t.type === "mcq" || isDone(t)) return;
    t.placement = {
      sliceIndex: state.currentIndex,
      x: clamp((clientX - rect.left) / rect.width, 0, 1),
      y: clamp((clientY - rect.top) / rect.height, 0, 1),
    };
    t.lastResult = null;
    saveProgress();
    renderAll();
  }

  // --- rendering ---------------------------------------------------------------------------

  function renderAll() {
    renderStage();
    renderInspector();
    if (!state.quiz) return;
    if (state.quiz.exportMode === "showcase") renderShowcaseList();
    else renderTargetsList();
  }

  function renderStage() {
    renderMarkers();
    renderToleranceOverlay();
    renderTicks();
    const t = currentTarget();
    stage.classList.toggle("armed-mode", !!t && t.type !== "mcq" && !isDone(t));
  }

  function renderTicks() {
    hintTicksEl.innerHTML = "";
    mineTicksEl.innerHTML = "";
    if (!state.quiz || state.quiz.exportMode !== "quiz") return;
    const count = state.manifest.sliceCount;

    const t = currentTarget();
    if (t && (t.type === "mcq" || isDone(t) || hintLevel(t) >= 1)) {
      hintTicksEl.appendChild(rangeTick(t.sliceFrom, t.sliceTo, count, true));
    }

    const placed = new Set(state.targets.filter((x) => x.type !== "mcq" && x.placement).map((x) => x.placement.sliceIndex));
    placed.forEach((idx) => mineTicksEl.appendChild(rangeTick(idx, idx, count, false)));
  }

  function rangeTick(from, to, count, active) {
    const tick = document.createElement("div");
    const left = sliderFraction(from, count) * 100;
    const right = sliderFraction(to, count) * 100;
    tick.className = "tick range" + (active ? " active" : "");
    tick.style.left = `calc(${left}% - 3px)`;
    tick.style.width = `calc(${Math.max(0, right - left)}% + 6px)`;
    return tick;
  }

  function renderToleranceOverlay() {
    if (!state.quiz) {
      toleranceLayer.innerHTML = "";
      return;
    }
    const size = state.manifest.size;
    const parts = [];
    const t = currentTarget();
    if (t && t.type !== "mcq" && appliesToSlice(t, state.currentIndex) && (isDone(t) || hintLevel(t) >= 2)) {
      const zone = zoneFor(t, state.currentIndex);
      parts.push(toleranceShapeMarkup(zone, size, "tolerance reveal"));
      if (isDone(t)) parts.push(`<circle class="reveal-dot" cx="${(zone.x * size).toFixed(1)}" cy="${(zone.y * size).toFixed(1)}" r="5" />`);
    }
    toleranceLayer.innerHTML = parts.join("");
  }

  function renderMarkers() {
    markerLayer.innerHTML = "";
    if (!state.quiz) return;

    if (state.quiz.exportMode === "showcase") {
      state.targets.filter((t) => appliesToSlice(t, state.currentIndex)).forEach((t) => {
        markerLayer.appendChild(buildShowcaseMarkerEl(t));
      });
      return;
    }

    const current = currentTarget();
    state.targets.forEach((t) => {
      // MCQs ask about a specific spot rather than testing whether the
      // student can find it, so they're always shown at their true location.
      if (t.type === "mcq") {
        if (appliesToSlice(t, state.currentIndex)) markerLayer.appendChild(buildMcqMarkerEl(t, t === current));
        return;
      }
      if (t.placement && t.placement.sliceIndex === state.currentIndex) {
        markerLayer.appendChild(buildGuessMarkerEl(t, t === current));
      }
    });
  }

  function markerInner(t, glyph) {
    if (t.type === "label") return `<span class="dot"></span><span class="chip">${escapeHtml(t.text || "")}</span>`;
    return `<span class="icon-circle">${glyph || (t.type === "pin" ? "i" : "?")}</span>`;
  }

  function outcomeClass(t) {
    if (t.status === "correct") return " outcome-correct";
    if (t.status === "revealed") return " outcome-incorrect";
    if (t.lastResult && !t.lastResult.correct) return " outcome-incorrect";
    return "";
  }

  function buildMcqMarkerEl(t, isCurrent) {
    const zone = zoneFor(t, state.currentIndex);
    const div = document.createElement("div");
    const pending = !t.status.match(/correct|revealed/) && t.choice && !(t.lastResult && !t.lastResult.correct) ? " outcome-pending" : "";
    div.className = `marker mcq-fixed${outcomeClass(t)}${pending}` + (isCurrent ? " selected" : "");
    div.style.left = `${zone.x * 100}%`;
    div.style.top = `${zone.y * 100}%`;
    div.title = t.question || "MCQ";
    div.innerHTML = markerInner(t, "?");
    div.addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.phase !== "start") goToItem(t.id);
    });
    return div;
  }

  function buildShowcaseMarkerEl(t) {
    const zone = zoneFor(t, state.currentIndex);
    const div = document.createElement("div");
    div.className = `marker showcase ${t.type}` + (t.id === state.currentId ? " selected" : "");
    div.style.left = `${zone.x * 100}%`;
    div.style.top = `${zone.y * 100}%`;
    if (t.type !== "label") div.title = summaryFor(t);
    div.innerHTML = markerInner(t);
    div.addEventListener("click", (e) => {
      e.stopPropagation();
      state.currentId = t.id;
      renderAll();
    });
    return div;
  }

  function buildGuessMarkerEl(t, isCurrent) {
    const div = document.createElement("div");
    const locked = isDone(t);
    div.className = `marker mine ${t.type}${outcomeClass(t)}` + (isCurrent ? " selected" : "") + (locked ? " locked" : "");
    div.style.left = `${t.placement.x * 100}%`;
    div.style.top = `${t.placement.y * 100}%`;
    div.innerHTML = markerInner(t);
    if (locked) {
      div.addEventListener("click", (e) => { e.stopPropagation(); goToItem(t.id); });
    } else {
      wireGuessDrag(div, t);
    }
    return div;
  }

  function wireGuessDrag(div, t) {
    div.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      div.setPointerCapture(e.pointerId);
      let dragging = false;
      let pendingX = t.placement.x;
      let pendingY = t.placement.y;
      const startX = e.clientX;
      const startY = e.clientY;

      const onMove = (moveEvt) => {
        if (!dragging && Math.hypot(moveEvt.clientX - startX, moveEvt.clientY - startY) > 8) dragging = true;
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
          t.placement.x = pendingX;
          t.placement.y = pendingY;
          t.lastResult = null;
          if (state.currentId !== t.id) state.currentId = t.id;
          saveProgress();
          renderAll();
        } else {
          goToItem(t.id);
        }
      };
      div.addEventListener("pointermove", onMove);
      div.addEventListener("pointerup", onUp, { once: true });
    });
  }

  // --- showcase list -------------------------------------------------------------------------

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
      if (t.id === state.currentId) li.classList.add("active");
      li.innerHTML = `
        ${iconHtmlFor(t.type)}
        <span class="label-text">${escapeHtml(summaryFor(t))}</span>
        <span class="slice-tag">#${rangeLabel(t)}</span>`;
      li.addEventListener("click", async () => {
        state.player.stop();
        if (!appliesToSlice(t, state.currentIndex)) await loadSlice(t.sliceFrom);
        state.currentId = t.id;
        renderAll();
      });
      showcaseListEl.appendChild(li);
    });
  }

  // --- quiz progress list -----------------------------------------------------------------------

  function statusClassFor(t) {
    if (t.status === "correct") return "correct";
    if (t.status === "revealed") return "revealed";
    if (t.placement || t.choice) return "attempted";
    if (t.skipped) return "skipped";
    return "todo";
  }

  function statusTextFor(t) {
    return { correct: "correct", revealed: "shown", attempted: "attempted", skipped: "skipped", todo: "not started" }[statusClassFor(t)];
  }

  function renderTargetsList() {
    if (!state.quiz || state.quiz.exportMode !== "quiz") return;
    const done = state.targets.filter(isDone).length;
    progressCountEl.textContent = `${done} / ${state.targets.length}`;
    targetsListEl.innerHTML = "";
    const locked = state.phase === "start";
    targetsListEl.classList.toggle("locked", locked);

    state.targets.forEach((t, i) => {
      const li = document.createElement("li");
      li.dataset.id = t.id;
      if (t.id === state.currentId) li.classList.add("current");
      if (locked) li.classList.add("locked");
      li.setAttribute("aria-label", `Item ${i + 1}: ${summaryFor(t)}, ${statusTextFor(t)}`);
      li.innerHTML = `
        <span class="status-icon ${statusClassFor(t)}" aria-hidden="true"></span>
        <span class="label-text">${escapeHtml(summaryFor(t))}</span>
        ${t.tries ? `<span class="tries" title="Wrong attempts">${t.tries}✕</span>` : ""}`;
      if (!locked) li.addEventListener("click", () => goToItem(t.id));
      targetsListEl.appendChild(li);
    });
    summaryBtn.disabled = locked;
    restartBtn.disabled = locked;
  }

  // --- inspector ------------------------------------------------------------------------------------

  function renderInspector() {
    if (!state.quiz) return;
    if (state.quiz.exportMode === "showcase") {
      const t = findTarget(state.currentId);
      inspectorEl.innerHTML = t ? buildShowcaseInspector(t) : `<p class="hint placeholder">Select an annotation to see its details.</p>`;
      if (t) el("closeInspector").addEventListener("click", () => { state.currentId = null; renderAll(); });
      return;
    }
    if (state.phase === "start") {
      inspectorEl.innerHTML = buildStartScreen();
      el("startBtn").addEventListener("click", startQuiz);
      return;
    }
    if (state.phase === "summary") {
      inspectorEl.innerHTML = buildSummary();
      inspectorEl.querySelectorAll("[data-retry]").forEach((b) => b.addEventListener("click", () => retryItem(b.dataset.retry)));
      const resume = el("resumeBtn");
      if (resume) resume.addEventListener("click", () => goToItem(nextTodo(null).id));
      el("summaryRestartBtn").addEventListener("click", restartQuiz);
      return;
    }
    const t = currentTarget();
    if (!t) {
      inspectorEl.innerHTML = `<p class="hint placeholder">Pick an item from the list to work on it.</p>`;
      return;
    }
    inspectorEl.innerHTML = buildItemInspector(t);
    wireItemInspector(t);
  }

  function buildStartScreen() {
    const n = state.targets.length;
    const placeN = state.targets.filter((t) => t.type !== "mcq").length;
    const mcqN = n - placeN;
    const guided = state.quiz.quizMode === "guided";
    return `
      <div class="intro">
        <h2 style="margin:0;font-size:1.05rem">Ready?</h2>
        <p style="margin:0">This quiz has <strong>${n} item${n === 1 ? "" : "s"}</strong>${mcqN ? ` (${placeN} to place, ${mcqN} question${mcqN === 1 ? "" : "s"})` : ""}. You'll work through them one at a time.</p>
        <ul>
          ${placeN ? `<li>Scrub through the slices with the slider, then tap the slice where the feature belongs. Drag your marker to adjust it before you check.</li>` : ""}
          ${guided && placeN ? `<li>A highlight under the slider shows which slices the current feature is on.</li>` : placeN ? `<li>If you miss, you'll get a hint about where to look.</li>` : ""}
          ${mcqN ? `<li>Questions are already placed on the slice; open one and choose an answer.</li>` : ""}
          <li>You can skip an item and come back to it. Your progress is saved in this browser.</li>
        </ul>
        <button type="button" id="startBtn" class="primary">${state.targets.some((t) => t.placement || t.choice || isDone(t)) ? "Continue" : "Start"}</button>
      </div>`;
  }

  function buildItemInspector(t) {
    const index = state.targets.indexOf(t) + 1;
    const header = `
      <div class="inspector-header">
        <p class="step">Item ${index} of ${state.targets.length} · ${TYPE_LABELS[t.type]}</p>
      </div>
      <p class="prompt">${escapeHtml(summaryFor(t))}</p>`;

    let body;
    if (t.type === "mcq") {
      body = `
        <p class="meta">On slice${isMultiSlice(t) ? "s" : ""} ${rangeLabel(t)} — already placed for you at the ? marker.</p>
        <div class="mcq-options" role="radiogroup" aria-label="Your answer">
          ${(t.options || []).map((o, i) => `
            <label><input type="radio" name="choice" value="${escapeHtml(o)}" ${o === t.choice ? "checked" : ""} ${isDone(t) ? "disabled" : ""} /> <span>${escapeHtml(o)}</span></label>`).join("")}
        </div>`;
    } else if (t.placement) {
      body = `<p class="meta">Your marker is on slice ${t.placement.sliceIndex}${t.placement.sliceIndex !== state.currentIndex ? ` (<button type="button" class="linklike" id="gotoPlacementBtn">show</button>)` : ""}.${isDone(t) ? "" : " Drag it to adjust."}</p>`;
    } else {
      body = `<p class="hint">Scrub to the slice you think this is on, then tap the spot.</p>`;
    }

    const level = hintLevel(t);
    let hintBlock = "";
    if (!isDone(t) && t.type !== "mcq" && level >= 1) {
      hintBlock = `<p class="hint">Hint: it's on slice${isMultiSlice(t) ? "s" : ""} <strong>${rangeLabel(t)}</strong>${level >= 2 ? ", and the accepted zone is now outlined on those slices" : ""}.</p>`;
    }

    let outcome = "";
    if (t.status === "correct") {
      outcome = `<div class="outcome-banner correct">Correct!${t.tries ? `<span class="sub">Took ${t.tries + 1} tries.</span>` : ""}</div>${revealBlock(t)}`;
    } else if (t.status === "revealed") {
      outcome = `<div class="outcome-banner incorrect">Here's where it is.<span class="sub">Marked as shown, not solved. You can retry it from the summary.</span></div>${revealBlock(t)}`;
    } else if (t.lastResult && !t.lastResult.correct) {
      outcome = `<div class="outcome-banner incorrect">Not right yet.<span class="sub">${missExplanation(t)}</span></div>`;
    }

    const actions = [];
    if (!isDone(t)) {
      if (t.type === "mcq") actions.push(`<button type="button" id="checkBtn" class="primary" ${t.choice ? "" : "disabled"}>Check answer</button>`);
      else {
        actions.push(`<button type="button" id="checkBtn" class="primary" ${t.placement ? "" : "disabled"}>Check placement</button>`);
        if (t.placement) actions.push(`<button type="button" id="clearBtn">Clear marker</button>`);
      }
      if (canShowMe(t)) actions.push(`<button type="button" id="showMeBtn">Show me</button>`);
      actions.push(`<button type="button" id="skipBtn">Skip</button>`);
    } else {
      actions.push(`<button type="button" id="nextBtn" class="primary">${nextTodo(t.id) ? "Next" : "Finish"}</button>`);
    }

    return `${header}${body}${hintBlock}${outcome}<div class="inspector-section btn-row">${actions.join("")}</div>`;
  }

  function missExplanation(t) {
    const r = t.lastResult.reason;
    if (t.type === "mcq") return "Try another answer.";
    if (r === "slice") {
      return hintLevel(t) >= 1
        ? `Your marker is on slice ${t.placement.sliceIndex}; the feature is on slice${isMultiSlice(t) ? "s" : ""} ${rangeLabel(t)}.`
        : "It's not on this slice. Scrub to a different one and try again.";
    }
    return "Right slice, but not the right spot. Move your marker and check again.";
  }

  function revealBlock(t) {
    if (t.type === "mcq") return `<div class="inspector-section"><h3 class="section-title">Answer</h3><p style="margin:0"><strong>${escapeHtml(t.answer || "")}</strong></p></div>`;
    if (t.type === "pin") return `<div class="inspector-section"><h3 class="section-title">About this feature</h3><p style="margin:0;font-size:0.88rem;line-height:1.45">${escapeHtml(t.description || "")}</p></div>`;
    return "";
  }

  function buildSummary() {
    const total = state.targets.length;
    const correct = state.targets.filter((t) => t.status === "correct").length;
    const remaining = state.targets.filter((t) => !isDone(t)).length;
    const rows = state.targets.map((t, i) => `
      <li>
        <span class="status-icon ${statusClassFor(t)}" aria-hidden="true"></span>
        <span class="label-text" title="${escapeHtml(summaryFor(t))}">${i + 1}. ${escapeHtml(summaryFor(t))}</span>
        <span class="tries">${t.status === "correct" ? `${t.tries + 1} tr${t.tries === 0 ? "y" : "ies"}` : t.status === "revealed" ? "shown" : t.skipped ? "skipped" : "open"}</span>
        <button type="button" data-retry="${escapeHtml(t.id)}">${isDone(t) ? "Retry" : "Go"}</button>
      </li>`).join("");
    return `
      <div class="inspector-header"><h2>Summary</h2></div>
      <p class="summary-total">${correct} of ${total} correct${remaining ? ` · ${remaining} still open` : ""}</p>
      <ul class="summary-list">${rows}</ul>
      <div class="inspector-section btn-row">
        ${remaining ? `<button type="button" id="resumeBtn" class="primary">Continue</button>` : ""}
        <button type="button" id="summaryRestartBtn" class="danger">Start over</button>
      </div>`;
  }

  function buildShowcaseInspector(t) {
    const header = `
      <div class="inspector-header"><h2>${TYPE_LABELS[t.type]}</h2><button type="button" id="closeInspector" title="Close" aria-label="Close">×</button></div>
      <p class="meta">Slice${isMultiSlice(t) ? "s" : ""} ${rangeLabel(t)} · layer: ${escapeHtml(t.layer || "unassigned")}</p>`;
    if (t.type === "label") return `${header}<p class="prompt">${escapeHtml(t.text || "")}</p>`;
    if (t.type === "pin") {
      return `${header}<p class="prompt">${escapeHtml(t.title || "")}</p><p style="margin:0;font-size:0.88rem;line-height:1.45">${escapeHtml(t.description || "")}</p>`;
    }
    const options = (t.options || []).map((o) => `<li class="${o === t.answer ? "correct-answer" : ""}">${escapeHtml(o)}</li>`).join("");
    return `${header}<p class="prompt">${escapeHtml(t.question || "")}</p><ul class="options-list">${options}</ul>`;
  }

  function wireItemInspector(t) {
    inspectorEl.querySelectorAll('input[name="choice"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        t.choice = radio.value;
        t.lastResult = null;
        saveProgress();
        renderAll();
      });
    });
    const on = (id, fn) => { const b = el(id); if (b) b.addEventListener("click", fn); };
    on("checkBtn", checkCurrent);
    on("clearBtn", () => { t.placement = null; t.lastResult = null; saveProgress(); renderAll(); });
    on("showMeBtn", revealCurrent);
    on("skipBtn", skipCurrent);
    on("nextBtn", advance);
    on("gotoPlacementBtn", () => loadSlice(t.placement.sliceIndex));
  }

  // --- import ------------------------------------------------------------------------------------

  async function importAnnotationsFile(file) {
    let text;
    let data;
    try {
      text = await file.text();
      data = JSON.parse(text);
    } catch {
      S.notify("error", `Could not import ${file.name}: the file is not valid JSON.`, { id: "import" });
      return;
    }
    const parsed = S.parseExportFile(data, state.manifest.sliceCount);
    if (parsed.error) {
      S.notify("error", `Could not import ${file.name}: ${parsed.error}.`, { id: "import" });
      return;
    }
    S.dismissNotice("import");
    S.dismissNotice("load");
    await loadQuizData(parsed.file, text, file.name);
  }

  // --- global wiring -----------------------------------------------------------------------------

  function wireGlobalControls() {
    scrub.addEventListener("input", () => {
      state.player.stop();
      loadSlice(Number(scrub.value));
    });
    playBtn.addEventListener("click", () => state.player.toggle());

    stage.addEventListener("click", (e) => {
      if (e.target.closest(".marker")) return;
      const t = currentTarget();
      if (t && t.type !== "mcq" && !isDone(t)) placeCurrent(e.clientX, e.clientY, stage.getBoundingClientRect());
    });

    sortOrderEl.addEventListener("change", renderShowcaseList);
    summaryBtn.addEventListener("click", showSummary);
    restartBtn.addEventListener("click", restartQuiz);

    importBtn.addEventListener("click", () => importFile.click());
    importFile.addEventListener("change", async () => {
      const file = importFile.files[0];
      if (file) await importAnnotationsFile(file);
      importFile.value = "";
    });
  }

  init();
})();
