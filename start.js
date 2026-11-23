/* Start page: choose images, pick the stack to work on, go annotate. */
(() => {
  "use strict";
  const S = window.Scanner;
  const { el, escapeHtml } = S;

  const MANIFEST_URL = "data/slices/manifest.json";

  const state = {
    datasets: [],
    folder: null, // manifest of data/slices/, when there is one
    storageOk: true,
    pending: null, // { prepared, picked, urls }
  };

  const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  // --- picking files ------------------------------------------------------------------

  function fromInput(input) {
    return Array.from(input.files).map((file) => ({ file, path: file.webkitRelativePath || file.name }));
  }

  function readEntries(reader) {
    return new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
  }

  async function walkEntry(entry, prefix, out) {
    if (entry.isFile) {
      const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
      if (file) out.push({ file, path: prefix + entry.name });
      return;
    }
    if (!entry.isDirectory) return;
    const reader = entry.createReader();
    for (;;) {
      const batch = await readEntries(reader);
      if (!batch.length) break;
      for (const child of batch) await walkEntry(child, `${prefix}${entry.name}/`, out);
    }
  }

  async function fromDrop(dataTransfer) {
    const items = Array.from(dataTransfer.items || []);
    const entries = items.map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null));
    if (!entries.some(Boolean)) return Array.from(dataTransfer.files).map((file) => ({ file, path: file.name }));
    const out = [];
    for (const entry of entries) if (entry) await walkEntry(entry, "", out);
    return out;
  }

  function setProgress(i, n, label) {
    const row = el("importProgressRow");
    if (i === null) {
      row.hidden = true;
      return;
    }
    row.hidden = false;
    el("importProgress").max = Math.max(n, 1);
    el("importProgress").value = i;
    el("importProgressText").textContent = `${label} ${i} of ${n}`;
  }

  // --- the pending import ------------------------------------------------------------

  function clearPending() {
    if (state.pending) state.pending.urls.forEach((u) => URL.revokeObjectURL(u));
    state.pending = null;
    el("pending").hidden = true;
    el("thumbStrip").innerHTML = "";
    el("importReport").innerHTML = "";
  }

  function reportLines(prepared) {
    const lines = [];
    const byReason = new Map();
    prepared.skipped.forEach((s) => {
      if (!byReason.has(s.reason)) byReason.set(s.reason, []);
      byReason.get(s.reason).push(s.name);
    });
    byReason.forEach((names, reason) => {
      const shown = names.slice(0, 8).join(", ") + (names.length > 8 ? `, and ${names.length - 8} more` : "");
      lines.push({ kind: "warn", text: `${count(names.length, "file")} skipped (${reason}): ${shown}` });
    });
    if (prepared.nested) lines.push({ kind: "info", text: `${count(prepared.nested, "file")} in sub-folders ${prepared.nested === 1 ? "was" : "were"} ignored.` });
    if (prepared.mixedSizes) {
      lines.push({ kind: "warn", text: "These images are not all the same size. Marker positions may not line up from one slice to the next." });
    }
    return lines;
  }

  async function handlePicked(picked) {
    clearPending();
    S.dismissNotice("import");
    if (!picked.length) return;
    if (picked.length === 1 && await S.looksLikeZip(picked[0].file)) {
      await handlePackage(picked[0].file);
      return;
    }
    let prepared;
    try {
      prepared = await S.prepareImport(picked, (i, n) => setProgress(i, n, "Reading image"));
    } catch (err) {
      setProgress(null);
      S.notify("error", `Those files could not be read: ${err.message}`, { id: "import" });
      return;
    }
    setProgress(null);

    if (!prepared.files.length) {
      const why = reportLines(prepared).map((l) => l.text).join(" ");
      S.notify("error", `No usable images in that selection. ${why}`.trim(), { id: "import" });
      return;
    }

    const existing = state.datasets.find((d) => d.id === prepared.datasetHash);
    if (existing) {
      S.setActiveId(existing.id);
      S.notify("info", `This stack is already stored as “${existing.name}”. It is now the one in use.`, { id: "import" });
      await refresh();
      return;
    }

    const urls = [];
    state.pending = { prepared, picked, urls };
    el("pendingSummary").textContent = `${count(prepared.files.length, "slice")} · ${S.formatBytes(prepared.bytes)}`;
    el("importReport").innerHTML = reportLines(prepared)
      .map((l) => `<li class="${l.kind}">${escapeHtml(l.text)}</li>`).join("");
    const strip = el("thumbStrip");
    prepared.files.forEach((f, i) => {
      const url = URL.createObjectURL(f.blob);
      urls.push(url);
      const li = document.createElement("li");
      li.title = f.name;
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      img.loading = "lazy";
      const num = document.createElement("span");
      num.className = "thumb-num";
      num.textContent = String(i + 1);
      const name = document.createElement("span");
      name.className = "thumb-name";
      name.textContent = f.name;
      li.append(img, num, name);
      strip.appendChild(li);
    });
    el("datasetName").value = S.suggestName(picked, prepared.files) || "Untitled stack";
    el("pending").hidden = false;
    el("datasetName").focus();
    el("datasetName").select();
  }

  async function savePending() {
    if (!state.pending) return;
    const { prepared } = state.pending;
    const name = el("datasetName").value.trim() || "Untitled stack";
    const btn = el("saveDatasetBtn");
    btn.disabled = true;
    setProgress(0, prepared.files.length, "Storing image");
    try {
      await S.saveDataset(S.recordFor(prepared, name), prepared.files);
    } catch (err) {
      setProgress(null);
      btn.disabled = false;
      S.notify("error",
        `${escapeHtml(`“${name}” could not be saved. ${S.storageErrorMessage(err)}`)}<br /><span class="notice-hint">Alternative: put the images in <code>data/slices/</code> and run <code>python3 scripts/build_manifest.py</code>.</span>`,
        { id: "import", html: true });
      return;
    }
    setProgress(null);
    btn.disabled = false;
    S.setActiveId(prepared.datasetHash);
    clearPending();
    S.notify("info", `Saved “${name}”. It is now the stack in use: go to step 3 to annotate it.`, { id: "import" });
    await refresh();
    el("annotateLink").focus();
  }

  async function handlePackage(file) {
    const record = await S.importPackageForEditing(file);
    if (!record) return;
    S.notify("info", `Opened “${record.name}” from ${file.name}. It is now the stack in use.`, { id: "import" });
    await refresh();
  }

  // --- the list of stacks -------------------------------------------------------------

  function promptDialog({ title, label, value, confirmLabel }) {
    return new Promise((resolve) => {
      const backdrop = document.createElement("div");
      backdrop.className = "modal-backdrop open";
      backdrop.innerHTML = `
        <form class="modal" role="dialog" aria-modal="true" aria-labelledby="promptTitle">
          <h3 id="promptTitle">${escapeHtml(title)}</h3>
          <div class="name-row">
            <label for="promptInput">${escapeHtml(label)}</label>
            <input type="text" id="promptInput" maxlength="120" autocomplete="off" />
          </div>
          <div class="modal-actions">
            <button type="button" id="promptCancelBtn">Cancel</button>
            <button type="submit" id="promptOkBtn" class="primary">${escapeHtml(confirmLabel)}</button>
          </div>
        </form>`;
      document.body.appendChild(backdrop);
      const input = backdrop.querySelector("#promptInput");
      input.value = value;
      const finish = (result) => {
        backdrop.remove();
        document.removeEventListener("keydown", onKey);
        resolve(result);
      };
      function onKey(e) {
        if (e.key === "Escape") finish(null);
      }
      document.addEventListener("keydown", onKey);
      backdrop.querySelector("#promptCancelBtn").addEventListener("click", () => finish(null));
      backdrop.addEventListener("click", (e) => { if (e.target === backdrop) finish(null); });
      backdrop.querySelector("form").addEventListener("submit", (e) => {
        e.preventDefault();
        finish(input.value.trim() || null);
      });
      input.focus();
      input.select();
    });
  }

  function annotationCount(id) {
    const held = S.createStore(`annotator:${id || "unfingerprinted"}:v3`).read();
    return Array.isArray(held) ? held.length : 0;
  }

  function renderList() {
    const activeId = state.storageOk ? S.getActiveId() : null;
    const active = state.datasets.find((d) => d.id === activeId) || null;
    const list = el("datasetList");
    list.innerHTML = "";

    const addRow = ({ value, name, meta, checked, record }) => {
      const li = document.createElement("li");
      if (checked) li.classList.add("current");
      const id = `use-${value}`;
      li.innerHTML = `
        <label for="${escapeHtml(id)}">
          <input type="radio" name="activeDataset" id="${escapeHtml(id)}" value="${escapeHtml(value)}" ${checked ? "checked" : ""} />
          <span class="ds-text"><span class="ds-name">${escapeHtml(name)}</span><span class="ds-meta">${escapeHtml(meta)}</span></span>
        </label>`;
      li.querySelector("input").addEventListener("change", async () => {
        S.setActiveId(record ? record.id : null);
        await refresh();
      });
      if (record) {
        const actions = document.createElement("div");
        actions.className = "ds-actions";
        const rename = document.createElement("button");
        rename.type = "button";
        rename.textContent = "Rename";
        rename.setAttribute("aria-label", `Rename ${record.name}`);
        rename.dataset.rename = record.id;
        rename.addEventListener("click", async () => {
          const next = await promptDialog({ title: "Rename this stack", label: "Name", value: record.name, confirmLabel: "Rename" });
          if (!next || next === record.name) return;
          try {
            await S.updateDataset(record.id, { name: next });
          } catch (err) {
            S.notify("error", `The stack could not be renamed. ${S.storageErrorMessage(err)}`, { id: "import" });
          }
          await refresh();
        });
        const del = document.createElement("button");
        del.type = "button";
        del.className = "danger";
        del.textContent = "Delete";
        del.setAttribute("aria-label", `Delete ${record.name}`);
        del.dataset.delete = record.id;
        del.addEventListener("click", async () => {
          const n = annotationCount(record.id);
          const ok = await S.confirmDialog({
            title: `Delete “${record.name}”?`,
            message: `This removes its ${count(record.files.length, "image")} from this browser.${n ? ` Its ${count(n, "annotation")} stay autosaved and come back if you choose the same images again.` : ""} Export a quiz package first if you want a copy.`,
            confirmLabel: "Delete images",
            danger: true,
          });
          if (!ok) return;
          try {
            await S.deleteDataset(record.id);
          } catch (err) {
            S.notify("error", `The stack could not be deleted. ${S.storageErrorMessage(err)}`, { id: "import" });
          }
          await refresh();
        });
        actions.append(rename, del);
        li.appendChild(actions);
      }
      list.appendChild(li);
    };

    state.datasets.forEach((d) => {
      const n = annotationCount(d.id);
      addRow({
        value: d.id,
        name: d.name,
        meta: [count(d.files.length, "slice"), S.formatBytes(d.bytes), `added ${new Date(d.createdAt).toLocaleDateString()}`, n ? count(n, "annotation") : ""].filter(Boolean).join(" · "),
        checked: active && active.id === d.id,
        record: d,
      });
    });
    if (state.folder) {
      const n = annotationCount(state.folder.datasetHash);
      addRow({
        value: "folder",
        name: state.folder.name || "Sample stack (folder)",
        meta: [count(state.folder.sliceCount, "slice"), "served from data/slices/", n ? count(n, "annotation") : ""].filter(Boolean).join(" · "),
        checked: !active,
        record: null,
      });
    }
    if (!list.children.length) {
      list.innerHTML = `<li class="empty">No image stack yet. Choose images in step 1.</li>`;
    }

    const current = active
      ? { name: active.name, slices: active.files.length }
      : state.folder ? { name: state.folder.name || "Sample stack (folder)", slices: state.folder.sliceCount } : null;
    el("datasetInfo").textContent = current ? `In use: ${current.name}` : "No image stack";
    el("activeLine").innerHTML = current
      ? `Working on <strong>${escapeHtml(current.name)}</strong> (${count(current.slices, "slice")}).`
      : "Choose images in step 1 first.";
    ["annotateLink", "quizLink"].forEach((id) => {
      const a = el(id);
      if (current) {
        a.removeAttribute("aria-disabled");
        a.removeAttribute("tabindex");
      } else {
        a.setAttribute("aria-disabled", "true");
        a.setAttribute("tabindex", "-1");
      }
    });
  }

  async function renderStorage() {
    const info = el("storageInfo");
    if (!state.storageOk) {
      info.textContent = "";
      return;
    }
    const est = await S.storageEstimate();
    const stored = state.datasets.reduce((sum, d) => sum + (d.bytes || 0), 0);
    if (est && est.quota) {
      info.textContent = `${count(state.datasets.length, "stack")} stored here, ${S.formatBytes(stored)} of images. This site is using ${S.formatBytes(est.usage || 0)} of about ${S.formatBytes(est.quota)} the browser allows.`;
    } else {
      info.textContent = `${count(state.datasets.length, "stack")} stored here, ${S.formatBytes(stored)} of images.`;
    }
  }

  async function refresh() {
    try {
      state.datasets = await S.listDatasets();
      state.storageOk = true;
      S.dismissNotice("storage");
    } catch (err) {
      state.datasets = [];
      state.storageOk = false;
      S.notify("warn", `${S.storageErrorMessage(err)} Images can't be kept in this browser; the folder stack still works.`, { id: "storage", dismissible: false });
    }
    renderList();
    await renderStorage();
  }

  // --- wiring -----------------------------------------------------------------------------

  function wire() {
    const bind = (btnId, inputId) => {
      const input = el(inputId);
      el(btnId).addEventListener("click", () => input.click());
      input.addEventListener("change", async () => {
        const picked = fromInput(input);
        input.value = "";
        await handlePicked(picked);
      });
    };
    bind("pickFilesBtn", "pickFiles");
    bind("pickFolderBtn", "pickFolder");
    bind("pickPackageBtn", "pickPackage");

    const zone = el("dropZone");
    ["dragenter", "dragover"].forEach((type) => zone.addEventListener(type, (e) => {
      e.preventDefault();
      zone.classList.add("over");
    }));
    ["dragleave", "drop"].forEach((type) => zone.addEventListener(type, () => zone.classList.remove("over")));
    zone.addEventListener("drop", async (e) => {
      e.preventDefault();
      await handlePicked(await fromDrop(e.dataTransfer));
    });
    // A file dropped beside the zone must not navigate the page away.
    ["dragover", "drop"].forEach((type) => document.addEventListener(type, (e) => e.preventDefault()));

    el("saveDatasetBtn").addEventListener("click", savePending);
    el("datasetName").addEventListener("keydown", (e) => {
      if (e.key === "Enter") savePending();
    });
    el("cancelImportBtn").addEventListener("click", clearPending);
    ["annotateLink", "quizLink"].forEach((id) => el(id).addEventListener("click", (e) => {
      if (el(id).getAttribute("aria-disabled") === "true") e.preventDefault();
    }));
  }

  async function init() {
    wire();
    try {
      state.folder = await S.loadManifest(MANIFEST_URL);
    } catch (err) {
      state.folder = null;
      if (location.protocol === "file:") {
        S.showFatal(err);
        return;
      }
    }
    await refresh();
  }

  init();
})();
