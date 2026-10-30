/* Shared runtime for the annotator and quiz pages.
 *
 * Loaded as a plain script (no module system, no build step) and exposed
 * as a single global, `Scanner`, so each page keeps working when served
 * from any static host - including Moodle's file serving, which doesn't
 * always set the MIME type ES modules require.
 *
 * Everything that used to be duplicated between the two apps lives here:
 * escaping, hashing, the SVG sanitiser, storage with failure reporting,
 * annotation validation / schema upgrade, slice loading with ordering,
 * and the geometry used for zones and grading.
 */
(() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const SCHEMA_VERSION = 3;
  const TYPE_LABELS = { label: "Text label", pin: "Pin + description", mcq: "MCQ" };
  const DEFAULT_TOLERANCE = { mode: "radius", radius: 0.06 };
  const IMAGE_EXTENSIONS = /\.(svg|png|jpe?g|gif|webp)$/i;

  // --- small helpers ---------------------------------------------------------

  const el = (id) => document.getElementById(id);

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function uid() {
    return "a-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  const isSvgFilename = (filename) => /\.svg$/i.test(filename);

  function isFiniteNumber(v) {
    return typeof v === "number" && Number.isFinite(v);
  }

  function isInteger(v) {
    return typeof v === "number" && Number.isInteger(v);
  }

  // --- SHA-256 ------------------------------------------------------------------
  //
  // crypto.subtle is only available in secure contexts (https or localhost).
  // A department server reached over plain http on the LAN has none, so a
  // small pure-JS implementation is used everywhere for consistency.

  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function sha256Hex(input) {
    const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
    const bitLen = bytes.length * 8;
    const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
    view.setUint32(padded.length - 4, bitLen >>> 0);

    const h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));

    for (let off = 0; off < padded.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
  }

  // --- SVG sanitiser --------------------------------------------------------------
  //
  // Slice SVGs are shown inline so their shapes are real DOM nodes (that is
  // what makes data-layer detection work). Inline SVG can carry script, so
  // every SVG goes through here first. The approach is an allowlist: only
  // known-safe elements and attributes are copied, into freshly created
  // nodes, and everything else is dropped. Building new nodes (rather than
  // serialising a cleaned tree back to text and re-parsing it) avoids the
  // class of bypasses that depend on serialise/parse differences.

  const SVG_ALLOWED_ELEMENTS = new Set([
    "svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon",
    "text", "tspan", "title", "desc", "defs", "linearGradient", "radialGradient", "stop", "clipPath",
  ]);

  const SVG_ALLOWED_ATTRIBUTES = new Set([
    "id", "class", "transform", "viewBox", "width", "height", "x", "y", "x1", "y1", "x2", "y2",
    "cx", "cy", "r", "rx", "ry", "d", "points", "fill", "fill-opacity", "fill-rule", "stroke",
    "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin", "stroke-dasharray",
    "stroke-dashoffset", "stroke-miterlimit", "opacity", "offset", "stop-color", "stop-opacity",
    "gradientUnits", "gradientTransform", "spreadMethod", "clip-path", "clip-rule", "clipPathUnits",
    "font-family", "font-size", "font-weight", "font-style", "text-anchor", "dominant-baseline",
    "letter-spacing", "preserveAspectRatio", "vector-effect", "paint-order", "visibility", "display",
    "style",
  ]);

  // url() is only allowed when it points at an id inside the same document
  // (gradients, clip paths). Anything else - external files, data: URIs,
  // javascript: - is rejected along with the whole attribute.
  const SAFE_LOCAL_URL = /^url\(\s*['"]?#[\w:.-]+['"]?\s*\)$/;

  function isSafeAttributeValue(name, value) {
    const v = String(value);
    const lowered = v.toLowerCase().replace(/\s+/g, "");
    if (lowered.includes("javascript:") || lowered.includes("data:") || lowered.includes("expression(")) return false;
    if (name === "style") {
      return !/url\(|@import|behavior|-moz-binding/i.test(v);
    }
    if (/url\(/i.test(v)) return SAFE_LOCAL_URL.test(v.trim());
    return true;
  }

  function copySafeNode(source, targetDoc) {
    if (source.nodeType === Node.TEXT_NODE) {
      return targetDoc.createTextNode(source.nodeValue);
    }
    if (source.nodeType !== Node.ELEMENT_NODE) return null;
    if (source.namespaceURI !== SVG_NS || !SVG_ALLOWED_ELEMENTS.has(source.localName)) return null;

    const out = targetDoc.createElementNS(SVG_NS, source.localName);
    for (const attr of Array.from(source.attributes)) {
      // Namespaced attributes (xlink:href, xml:*) never match the allowlist.
      if (attr.prefix || attr.namespaceURI) continue;
      const name = attr.localName;
      const isData = name.startsWith("data-") && !name.includes(":");
      if (!isData && !SVG_ALLOWED_ATTRIBUTES.has(name)) continue;
      if (name.toLowerCase().startsWith("on")) continue;
      if (!isSafeAttributeValue(name, attr.value)) continue;
      out.setAttribute(name, attr.value);
    }
    for (const child of Array.from(source.childNodes)) {
      const copy = copySafeNode(child, targetDoc);
      if (copy) out.appendChild(copy);
    }
    return out;
  }

  /** Parse SVG markup and return a sanitised <svg> element, or null when the
   *  input isn't a usable SVG document at all. */
  function sanitizeSvg(markup) {
    let parsed;
    try {
      parsed = new DOMParser().parseFromString(String(markup), "image/svg+xml");
    } catch {
      return null;
    }
    const root = parsed.documentElement;
    if (!root || root.namespaceURI !== SVG_NS || root.localName !== "svg") return null;
    if (parsed.getElementsByTagName("parsererror").length) return null;
    return copySafeNode(root, document);
  }

  // --- storage with failure reporting ---------------------------------------------
  //
  // localStorage can be missing, blocked (third-party iframe on Safari), or
  // full. Work must never silently vanish, so every store reports whether a
  // write actually landed, and the apps show a heads-up when it didn't.

  function storageAvailable() {
    try {
      const probe = "scanner:probe:" + Math.random().toString(36).slice(2);
      localStorage.setItem(probe, "1");
      localStorage.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  }

  function createStore(key) {
    return {
      key,
      read() {
        try {
          const raw = localStorage.getItem(key);
          return raw ? JSON.parse(raw) : null;
        } catch {
          return null;
        }
      },
      write(value) {
        try {
          localStorage.setItem(key, JSON.stringify(value));
          return true;
        } catch {
          return false;
        }
      },
      remove() {
        try {
          localStorage.removeItem(key);
        } catch {
          /* nothing to do */
        }
      },
    };
  }

  // --- notices (banners under the header) ----------------------------------------

  function noticeHost() {
    let host = el("notices");
    if (!host) {
      host = document.createElement("div");
      host.id = "notices";
      host.className = "notices";
      const header = document.querySelector("header");
      if (header && header.parentNode) header.parentNode.insertBefore(host, header.nextSibling);
      else document.body.prepend(host);
    }
    return host;
  }

  /**
   * Show a banner. `kind` is "info" | "warn" | "error". `id` makes the banner
   * singular (re-showing replaces it). Returns the element.
   */
  function notify(kind, message, { id, dismissible = true, html = false } = {}) {
    const host = noticeHost();
    if (id) {
      const existing = host.querySelector(`[data-notice-id="${id}"]`);
      if (existing) existing.remove();
    }
    const div = document.createElement("div");
    div.className = `notice ${kind}`;
    div.setAttribute("role", kind === "error" ? "alert" : "status");
    if (id) div.dataset.noticeId = id;
    const body = document.createElement("div");
    body.className = "notice-body";
    if (html) body.innerHTML = message;
    else body.textContent = message;
    div.appendChild(body);
    if (dismissible) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "notice-close";
      btn.setAttribute("aria-label", "Dismiss");
      btn.textContent = "×";
      btn.addEventListener("click", () => div.remove());
      div.appendChild(btn);
    }
    host.appendChild(div);
    return div;
  }

  function dismissNotice(id) {
    const existing = noticeHost().querySelector(`[data-notice-id="${id}"]`);
    if (existing) existing.remove();
  }

  /**
   * Modal confirm. Resolves true/false. Used instead of window.confirm so the
   * message can carry detail and the buttons can say what they do.
   */
  function confirmDialog({ title, message, confirmLabel = "OK", cancelLabel = "Cancel", danger = false }) {
    return new Promise((resolve) => {
      const backdrop = document.createElement("div");
      backdrop.className = "modal-backdrop open";
      backdrop.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">
          <h3 id="confirmTitle">${escapeHtml(title)}</h3>
          <p>${escapeHtml(message)}</p>
          <div class="modal-actions">
            <button type="button" id="confirmCancelBtn">${escapeHtml(cancelLabel)}</button>
            <button type="button" id="confirmOkBtn" class="${danger ? "danger" : "primary"}">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>`;
      document.body.appendChild(backdrop);
      const finish = (value) => {
        backdrop.remove();
        document.removeEventListener("keydown", onKey);
        resolve(value);
      };
      function onKey(e) {
        if (e.key === "Escape") finish(false);
      }
      document.addEventListener("keydown", onKey);
      backdrop.querySelector("#confirmCancelBtn").addEventListener("click", () => finish(false));
      backdrop.querySelector("#confirmOkBtn").addEventListener("click", () => finish(true));
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) finish(false);
      });
      backdrop.querySelector("#confirmOkBtn").focus();
    });
  }

  // --- loading the dataset -------------------------------------------------------

  class LoadError extends Error {
    constructor(message, hint) {
      super(message);
      this.hint = hint || "";
    }
  }

  const SERVE_HINT = "Serve the folder over HTTP, e.g. run `python3 -m http.server` in the project folder and open http://localhost:8000/.";

  async function fetchText(url, what) {
    if (location.protocol === "file:") {
      throw new LoadError(`${what} can't be loaded when the page is opened directly from the file system.`, SERVE_HINT);
    }
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      throw new LoadError(`${what} could not be fetched (${url}).`, `Network error: ${err.message}. ${SERVE_HINT}`);
    }
    if (!res.ok) {
      throw new LoadError(`${what} returned HTTP ${res.status} (${url}).`,
        res.status === 404 ? "Check the file exists at that path relative to this page." : "");
    }
    return res.text();
  }

  async function fetchJson(url, what) {
    const text = await fetchText(url, what);
    try {
      return { text, data: JSON.parse(text) };
    } catch (err) {
      throw new LoadError(`${what} is not valid JSON (${url}).`, err.message);
    }
  }

  function validateManifest(m) {
    if (!m || typeof m !== "object") throw new LoadError("manifest.json is not an object.");
    if (!Array.isArray(m.files) || !m.files.length) {
      throw new LoadError("manifest.json lists no slice files.", "Put images in data/slices/ and run `python3 scripts/build_manifest.py`.");
    }
    if (!m.files.every((f) => typeof f === "string" && IMAGE_EXTENSIONS.test(f))) {
      throw new LoadError("manifest.json contains a file entry that isn't an image filename.");
    }
    return {
      size: isFiniteNumber(m.size) && m.size > 0 ? m.size : 400,
      sliceCount: m.files.length,
      axis: typeof m.axis === "string" ? m.axis : "",
      layers: Array.isArray(m.layers) ? m.layers : [],
      files: m.files.slice(),
      fileHashes: m.fileHashes && typeof m.fileHashes === "object" ? m.fileHashes : null,
      datasetHash: typeof m.datasetHash === "string" && /^[0-9a-f]{64}$/.test(m.datasetHash) ? m.datasetHash : null,
    };
  }

  async function loadManifest(url) {
    const { data } = await fetchJson(url, "The slice manifest");
    return validateManifest(data);
  }

  /** Render a load failure in place of the normal UI. */
  function showFatal(err) {
    const message = err instanceof LoadError ? err.message : `Something went wrong: ${err && err.message ? err.message : err}`;
    const hint = err instanceof LoadError ? err.hint : "";
    notify("error", `${escapeHtml(message)}${hint ? `<br /><span class="notice-hint">${escapeHtml(hint)}</span>` : ""}`,
      { id: "fatal", dismissible: false, html: true });
    document.querySelectorAll("main button, main input, main select").forEach((c) => { c.disabled = true; });
    const info = el("datasetInfo");
    if (info) info.textContent = "Failed to load";
  }

  /**
   * Slice loader with ordering: each load() gets a sequence number and only
   * the most recent request may touch the DOM. Resolves to true when the
   * requested slice is the one now shown, false when a later request
   * superseded it.
   */
  function createSliceLoader({ host, manifest, sliceUrl }) {
    let seq = 0;
    const cache = new Map();

    function showPlaceholder(filename, reason) {
      host.innerHTML = "";
      const box = document.createElement("div");
      box.className = "slice-missing";
      box.innerHTML = `<strong>Slice image unavailable</strong><span>${escapeHtml(filename)}</span><span class="notice-hint">${escapeHtml(reason)}</span>`;
      host.appendChild(box);
    }

    async function load(index) {
      const mySeq = ++seq;
      const filename = manifest.files[index - 1];
      if (!filename) {
        showPlaceholder(`slice ${index}`, "Not listed in manifest.json.");
        return mySeq === seq;
      }

      if (!isSvgFilename(filename)) {
        if (mySeq !== seq) return false;
        host.innerHTML = "";
        const img = document.createElement("img");
        img.alt = "";
        img.draggable = false;
        img.addEventListener("error", () => {
          if (mySeq === seq) showPlaceholder(filename, "The file could not be loaded.");
        });
        img.src = sliceUrl(filename);
        host.appendChild(img);
        return true;
      }

      let markup = cache.get(filename);
      if (markup === undefined) {
        try {
          markup = await fetchText(sliceUrl(filename), `Slice ${index}`);
          cache.set(filename, markup);
        } catch (err) {
          if (mySeq !== seq) return false;
          showPlaceholder(filename, err.message);
          return true;
        }
      }
      if (mySeq !== seq) return false;

      const svg = sanitizeSvg(markup);
      host.innerHTML = "";
      if (!svg) {
        showPlaceholder(filename, "The file is not a valid SVG image.");
        return true;
      }
      host.appendChild(svg);
      return true;
    }

    return { load };
  }

  // --- annotations: schema, validation, upgrade --------------------------------------
  //
  // Schema v3 (this version):
  //   { id, type, sliceFrom, sliceTo, layer, x, y, tolerance, overrides?, ...type fields }
  // An annotation applies to every slice in [sliceFrom, sliceTo]. x/y/
  // tolerance describe the default zone; `overrides` maps a slice index to a
  // {x, y, tolerance} that replaces it on that slice only.
  //
  // Schema v2 had a single `sliceIndex`; it upgrades to sliceFrom = sliceTo.

  function normalizeTolerance(raw) {
    const t = raw && typeof raw === "object" ? raw : {};
    const polygon = Array.isArray(t.polygon)
      ? t.polygon
        .filter((p) => p && isFiniteNumber(p.x) && isFiniteNumber(p.y))
        .map((p) => ({ x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) }))
      : null;
    const radius = isFiniteNumber(t.radius) && t.radius > 0 ? clamp(t.radius, 0.005, 1) : DEFAULT_TOLERANCE.radius;
    const out = { mode: "radius", radius };
    if (polygon && polygon.length >= 3) {
      out.polygon = polygon;
      if (t.mode === "polygon") out.mode = "polygon";
    }
    return out;
  }

  function normalizeZone(raw) {
    if (!raw || typeof raw !== "object" || !isFiniteNumber(raw.x) || !isFiniteNumber(raw.y)) return null;
    return { x: clamp(raw.x, 0, 1), y: clamp(raw.y, 0, 1), tolerance: normalizeTolerance(raw.tolerance) };
  }

  function stringField(v, max) {
    if (v === undefined || v === null) return "";
    const s = String(v);
    return max ? s.slice(0, max) : s;
  }

  /**
   * Validate and normalise one raw annotation. Returns { annotation } or
   * { error } (a human-readable reason). `sliceCount` bounds slice indices
   * when known (pass 0 to skip the upper bound).
   */
  function normalizeAnnotation(raw, sliceCount) {
    if (!raw || typeof raw !== "object") return { error: "not an object" };
    if (!TYPE_LABELS[raw.type]) return { error: `unknown type ${JSON.stringify(raw.type)}` };

    let from;
    let to;
    if (isInteger(raw.sliceFrom) || isInteger(raw.sliceTo)) {
      from = raw.sliceFrom;
      to = raw.sliceTo ?? raw.sliceFrom;
    } else {
      from = raw.sliceIndex;
      to = raw.sliceIndex;
    }
    if (!isInteger(from) || !isInteger(to)) return { error: "slice index is not a whole number" };
    if (from > to) [from, to] = [to, from];
    if (from < 1 || (sliceCount && to > sliceCount)) {
      return { error: `slice range ${from}–${to} is outside 1–${sliceCount || "?"}` };
    }
    if (!isFiniteNumber(raw.x) || !isFiniteNumber(raw.y)) return { error: "position is not numeric" };

    const ann = {
      id: typeof raw.id === "string" && raw.id ? raw.id.slice(0, 80) : uid(),
      type: raw.type,
      sliceFrom: from,
      sliceTo: to,
      layer: typeof raw.layer === "string" && raw.layer ? raw.layer.slice(0, 40) : null,
      x: clamp(raw.x, 0, 1),
      y: clamp(raw.y, 0, 1),
      tolerance: normalizeTolerance(raw.tolerance),
      overrides: {},
    };

    if (raw.overrides && typeof raw.overrides === "object") {
      for (const key of Object.keys(raw.overrides)) {
        const idx = Number(key);
        if (!Number.isInteger(idx) || idx < from || idx > to) continue;
        const zone = normalizeZone(raw.overrides[key]);
        if (zone) ann.overrides[idx] = zone;
      }
    }

    if (ann.type === "label") {
      ann.text = stringField(raw.text, 80);
    } else if (ann.type === "pin") {
      ann.title = stringField(raw.title, 120);
      ann.description = stringField(raw.description, 4000);
    } else {
      ann.question = stringField(raw.question, 500);
      ann.options = Array.isArray(raw.options) ? raw.options.map((o) => stringField(o, 200)).filter(Boolean).slice(0, 20) : [];
      ann.answer = stringField(raw.answer, 200);
      if (ann.options.length && !ann.options.includes(ann.answer)) ann.answer = ann.options[0];
    }
    return { annotation: ann };
  }

  /** Normalise a list; returns { annotations, rejected: [{ index, error }] }. */
  function normalizeAnnotations(list, sliceCount) {
    const annotations = [];
    const rejected = [];
    const seen = new Set();
    (Array.isArray(list) ? list : []).forEach((raw, index) => {
      const result = normalizeAnnotation(raw, sliceCount);
      if (result.error) {
        rejected.push({ index, error: result.error });
        return;
      }
      if (seen.has(result.annotation.id)) result.annotation.id = uid();
      seen.add(result.annotation.id);
      annotations.push(result.annotation);
    });
    return { annotations, rejected };
  }

  function describeRejected(rejected) {
    return rejected.slice(0, 5).map((r) => `entry ${r.index + 1}: ${r.error}`).join("; ") +
      (rejected.length > 5 ? `; and ${rejected.length - 5} more` : "");
  }

  /** Validate a whole export file. Returns { file } or { error }. */
  function parseExportFile(data, sliceCount) {
    if (!data || typeof data !== "object") return { error: "Not an annotations export" };
    if (!Array.isArray(data.annotations)) return { error: "Missing annotations array" };
    const exportMode = data.exportMode === "showcase" ? "showcase" : "quiz";
    const quizMode = data.quizMode === "guided" ? "guided" : "full";
    const { annotations, rejected } = normalizeAnnotations(data.annotations, sliceCount);
    if (rejected.length && !annotations.length) {
      return { error: `No usable annotations (${describeRejected(rejected)})` };
    }
    return {
      file: {
        version: isInteger(data.version) ? data.version : 2,
        exportMode,
        quizMode,
        datasetHash: typeof data.datasetHash === "string" && /^[0-9a-f]{64}$/.test(data.datasetHash) ? data.datasetHash : null,
        dataset: data.dataset && typeof data.dataset === "object" ? {
          size: isFiniteNumber(data.dataset.size) ? data.dataset.size : null,
          sliceCount: isInteger(data.dataset.sliceCount) ? data.dataset.sliceCount : null,
          axis: typeof data.dataset.axis === "string" ? data.dataset.axis : "",
        } : { size: null, sliceCount: null, axis: "" },
        annotations,
        rejected,
      },
    };
  }

  function buildExport({ manifest, annotations, exportMode, quizMode }) {
    return {
      version: SCHEMA_VERSION,
      exportMode,
      ...(exportMode === "quiz" ? { quizMode } : {}),
      datasetHash: manifest.datasetHash,
      dataset: { size: manifest.size, sliceCount: manifest.sliceCount, axis: manifest.axis },
      annotations: annotations.map(serializeAnnotation),
    };
  }

  // Overrides are stored with integer keys internally; emit them with the
  // empty object dropped so single-slice exports stay compact.
  function serializeAnnotation(ann) {
    const out = { ...ann };
    if (!out.overrides || !Object.keys(out.overrides).length) delete out.overrides;
    return out;
  }

  /**
   * Compare an export against the loaded manifest.
   * Returns { status: "match" | "mismatch" | "unverified", message }.
   */
  function compareDataset(file, manifest) {
    if (!file.datasetHash || !manifest.datasetHash) {
      const countsDiffer = file.dataset && file.dataset.sliceCount && file.dataset.sliceCount !== manifest.sliceCount;
      return {
        status: countsDiffer ? "mismatch" : "unverified",
        message: countsDiffer
          ? `This file was made for a stack of ${file.dataset.sliceCount} slices; this one has ${manifest.sliceCount}.`
          : "This file predates image-stack fingerprints, so it can't be verified against these images.",
      };
    }
    if (file.datasetHash === manifest.datasetHash) return { status: "match", message: "" };
    return {
      status: "mismatch",
      message: "This file was made against a different set of slice images. It may belong to another quiz, or the images may have changed since it was exported.",
    };
  }

  // --- geometry: zones, ranges, grading --------------------------------------------

  function appliesToSlice(ann, index) {
    return index >= ann.sliceFrom && index <= ann.sliceTo;
  }

  function isMultiSlice(ann) {
    return ann.sliceTo > ann.sliceFrom;
  }

  function hasOverride(ann, index) {
    return !!(ann.overrides && ann.overrides[index]);
  }

  /** The zone ({x, y, tolerance}) in effect on a given slice. */
  function zoneFor(ann, index) {
    if (hasOverride(ann, index)) return ann.overrides[index];
    return { x: ann.x, y: ann.y, tolerance: ann.tolerance };
  }

  function rangeLabel(ann) {
    return isMultiSlice(ann) ? `${ann.sliceFrom}–${ann.sliceTo}` : `${ann.sliceFrom}`;
  }

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

  function isWithinZone(zone, x, y) {
    const tol = zone.tolerance || DEFAULT_TOLERANCE;
    if (tol.mode === "polygon" && tol.polygon && tol.polygon.length >= 3) {
      return pointInPolygon(x, y, tol.polygon);
    }
    return Math.hypot(x - zone.x, y - zone.y) <= (tol.radius ?? DEFAULT_TOLERANCE.radius);
  }

  /** Grade a placement on a given slice. */
  function gradePlacement(ann, placement) {
    if (!placement) return { correct: false, reason: "none" };
    if (!appliesToSlice(ann, placement.sliceIndex)) return { correct: false, reason: "slice" };
    const zone = zoneFor(ann, placement.sliceIndex);
    return isWithinZone(zone, placement.x, placement.y)
      ? { correct: true, reason: "" }
      : { correct: false, reason: "spot" };
  }

  function toleranceShapeMarkup(zone, size, className) {
    const tol = zone.tolerance || DEFAULT_TOLERANCE;
    if (tol.mode === "polygon" && tol.polygon && tol.polygon.length >= 3) {
      const pts = tol.polygon.map((p) => `${(p.x * size).toFixed(1)},${(p.y * size).toFixed(1)}`).join(" ");
      return `<polygon class="${className}" points="${pts}" />`;
    }
    const r = (tol.radius ?? DEFAULT_TOLERANCE.radius) * size;
    return `<circle class="${className}" cx="${(zone.x * size).toFixed(1)}" cy="${(zone.y * size).toFixed(1)}" r="${r.toFixed(1)}" />`;
  }

  // --- presentation helpers shared by both apps ------------------------------------

  function summaryFor(ann) {
    if (ann.type === "label") return ann.text || "(empty label)";
    if (ann.type === "pin") return ann.title || "(untitled pin)";
    return ann.question || "(untitled question)";
  }

  function iconHtmlFor(type, extraClass) {
    const cls = extraClass ? ` ${extraClass}` : "";
    if (type === "label") return `<span class="icon label${cls}" aria-hidden="true"></span>`;
    if (type === "pin") return `<span class="icon pin${cls}" aria-hidden="true">i</span>`;
    return `<span class="icon mcq${cls}" aria-hidden="true">?</span>`;
  }

  function sortAnnotations(list, order) {
    const copy = list.slice();
    if (order === "type") {
      return copy.sort((a, b) => TYPE_LABELS[a.type].localeCompare(TYPE_LABELS[b.type]) || a.sliceFrom - b.sliceFrom);
    }
    if (order === "title-asc") return copy.sort((a, b) => summaryFor(a).localeCompare(summaryFor(b)));
    if (order === "title-desc") return copy.sort((a, b) => summaryFor(b).localeCompare(summaryFor(a)));
    return copy.sort((a, b) => a.sliceFrom - b.sliceFrom || a.sliceTo - b.sliceTo);
  }

  /** Position (0..1 along the slider track) for a slice index. */
  function sliderFraction(index, count) {
    return count > 1 ? (index - 1) / (count - 1) : 0;
  }

  // Playback that waits for each slice to finish loading before scheduling
  // the next one, so a slow connection can't let the display fall behind
  // the app's idea of the current slice.
  function createPlayer({ button, interval, step }) {
    let playing = false;
    let timer = null;
    let token = 0;

    async function tick(myToken) {
      if (!playing || myToken !== token) return;
      await step();
      if (!playing || myToken !== token) return;
      timer = setTimeout(() => tick(myToken), interval);
    }

    return {
      get playing() { return playing; },
      start() {
        if (playing) return;
        playing = true;
        token += 1;
        button.textContent = "Pause";
        button.setAttribute("aria-pressed", "true");
        tick(token);
      },
      stop() {
        playing = false;
        token += 1;
        clearTimeout(timer);
        button.textContent = "Play";
        button.setAttribute("aria-pressed", "false");
      },
      toggle() {
        if (playing) this.stop();
        else this.start();
      },
    };
  }

  window.Scanner = {
    SCHEMA_VERSION,
    TYPE_LABELS,
    DEFAULT_TOLERANCE,
    el,
    clamp,
    escapeHtml,
    uid,
    isSvgFilename,
    sha256Hex,
    sanitizeSvg,
    storageAvailable,
    createStore,
    notify,
    dismissNotice,
    confirmDialog,
    LoadError,
    fetchText,
    fetchJson,
    loadManifest,
    showFatal,
    createSliceLoader,
    normalizeTolerance,
    normalizeAnnotation,
    normalizeAnnotations,
    describeRejected,
    parseExportFile,
    buildExport,
    compareDataset,
    appliesToSlice,
    isMultiSlice,
    hasOverride,
    zoneFor,
    rangeLabel,
    pointInPolygon,
    isWithinZone,
    gradePlacement,
    toleranceShapeMarkup,
    summaryFor,
    iconHtmlFor,
    sortAnnotations,
    sliderFraction,
    createPlayer,
  };
})();
