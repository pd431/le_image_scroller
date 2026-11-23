/* Browser-side datasets: importing image files, caching them in IndexedDB,
 * and packaging a stack with its annotations as one zip.
 *
 * Loaded after common.js and attached to the same `Scanner` global. Nothing
 * here talks to a server: a dataset is a record (name, ordered file list,
 * hashes) plus one stored blob per slice, keyed by the stack's fingerprint.
 *
 * The fingerprint is computed exactly as scripts/lib_manifest.py does, so a
 * stack imported here and the same files dropped in data/slices/ get the
 * same datasetHash - annotations made on one line up with the other.
 */
(() => {
  "use strict";
  const S = window.Scanner;
  const { LoadError, isSvgFilename } = S;

  const DB_NAME = "scanner";
  const DB_VERSION = 1;
  const ACTIVE_KEY = "scanner:activeDataset";
  const IMAGE_EXTENSIONS = /\.(svg|png|jpe?g|gif|webp)$/i;
  const MIME_BY_EXT = {
    svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  };

  const mimeFor = (name) => MIME_BY_EXT[(name.split(".").pop() || "").toLowerCase()] || "application/octet-stream";

  // --- ordering and hashing (mirrors scripts/lib_manifest.py) ------------------------

  /** Natural filename order: digit runs compare as numbers, text
   *  case-insensitively - abc2 < abc10, zero-padded or not. */
  function naturalKey(name) {
    return name.split(/(\d+)/).map((chunk, i) => (i % 2 ? BigInt(chunk) : chunk.toLowerCase()));
  }

  function naturalCompare(a, b) {
    const ka = naturalKey(a);
    const kb = naturalKey(b);
    const n = Math.min(ka.length, kb.length);
    for (let i = 0; i < n; i++) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    if (ka.length !== kb.length) return ka.length - kb.length;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  const toHex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");

  /** SHA-256 of an ArrayBuffer. Web Crypto where the page is a secure
   *  context (localhost, https); the pure-JS fallback elsewhere. */
  async function hashBytes(buffer) {
    if (window.crypto && crypto.subtle) {
      try {
        return toHex(await crypto.subtle.digest("SHA-256", buffer));
      } catch {
        /* fall through */
      }
    }
    return S.sha256Hex(buffer);
  }

  function datasetHashFor(files, fileHashes) {
    return S.sha256Hex(files.map((name) => `${name}:${fileHashes[name]}\n`).join(""));
  }

  // --- IndexedDB -----------------------------------------------------------------------

  const req = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const txDone = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("The storage transaction was aborted."));
  });

  let dbPromise = null;
  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) {
          reject(new Error("This browser has no IndexedDB."));
          return;
        }
        let open;
        try {
          open = indexedDB.open(DB_NAME, DB_VERSION);
        } catch (err) {
          reject(err);
          return;
        }
        open.onupgradeneeded = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("datasets")) db.createObjectStore("datasets", { keyPath: "id" });
          if (!db.objectStoreNames.contains("slices")) db.createObjectStore("slices");
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error || new Error("Browser storage could not be opened."));
        open.onblocked = () => reject(new Error("Browser storage is in use by another tab."));
      });
      dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
  }

  /** Explain a storage failure in words the start page can show. */
  function storageErrorMessage(err) {
    const name = err && err.name;
    if (name === "QuotaExceededError") return "The browser's storage quota is full.";
    if (name === "SecurityError" || name === "InvalidStateError") return "This browser is blocking storage for this page (private window or embedded frame).";
    return `Browser storage failed${err && err.message ? `: ${err.message}` : "."}`;
  }

  const sliceKey = (id, name) => `${id}/${name}`;

  async function listDatasets() {
    const db = await openDb();
    const all = await req(db.transaction("datasets").objectStore("datasets").getAll());
    return all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  async function getDataset(id) {
    if (!id) return null;
    const db = await openDb();
    return (await req(db.transaction("datasets").objectStore("datasets").get(id))) || null;
  }

  /** Store a dataset record and its slice bytes in one transaction, so a
   *  failure (quota) leaves nothing half-written. */
  async function saveDataset(record, files) {
    const buffers = [];
    for (const f of files) buffers.push({ name: f.name, type: f.blob.type || mimeFor(f.name), buffer: await f.blob.arrayBuffer() });
    const db = await openDb();
    const tx = db.transaction(["datasets", "slices"], "readwrite");
    const done = txDone(tx);
    tx.objectStore("datasets").put(record);
    const slices = tx.objectStore("slices");
    buffers.forEach((b) => slices.put({ type: b.type, buffer: b.buffer }, sliceKey(record.id, b.name)));
    await done;
    return record;
  }

  async function updateDataset(id, changes) {
    const db = await openDb();
    const tx = db.transaction("datasets", "readwrite");
    const done = txDone(tx);
    const store = tx.objectStore("datasets");
    const record = await req(store.get(id));
    if (record) store.put({ ...record, ...changes });
    await done;
    return record ? { ...record, ...changes } : null;
  }

  async function deleteDataset(id) {
    const record = await getDataset(id);
    const db = await openDb();
    const tx = db.transaction(["datasets", "slices"], "readwrite");
    const done = txDone(tx);
    tx.objectStore("datasets").delete(id);
    const slices = tx.objectStore("slices");
    ((record && record.files) || []).forEach((name) => slices.delete(sliceKey(id, name)));
    await done;
    if (getActiveId() === id) setActiveId(null);
  }

  async function readSliceBlob(id, name) {
    const db = await openDb();
    const row = await req(db.transaction("slices").objectStore("slices").get(sliceKey(id, name)));
    if (!row) throw new LoadError(`${name} is missing from the browser cache.`, "Import the images again from the start page.");
    return new Blob([row.buffer], { type: row.type || mimeFor(name) });
  }

  async function storageEstimate() {
    try {
      if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
    } catch {
      /* not available */
    }
    return null;
  }

  // --- the active dataset -----------------------------------------------------------

  function getActiveId() {
    try {
      return localStorage.getItem(ACTIVE_KEY) || null;
    } catch {
      return null;
    }
  }

  function setActiveId(id) {
    try {
      if (id) localStorage.setItem(ACTIVE_KEY, id);
      else localStorage.removeItem(ACTIVE_KEY);
      return true;
    } catch {
      return false;
    }
  }

  function manifestFromRecord(record) {
    return {
      name: record.name,
      size: record.size || 400,
      sliceCount: record.files.length,
      axis: record.axis || "",
      layers: record.layers || [],
      files: record.files.slice(),
      fileHashes: record.fileHashes,
      datasetHash: record.id,
    };
  }

  /** A source is what the apps load slices from. `readSlice` hands back a
   *  Blob for a filename, whichever place the bytes live in. */
  function cacheSource(record) {
    return {
      kind: "cache",
      id: record.id,
      name: record.name,
      record,
      manifest: manifestFromRecord(record),
      readSlice: (name) => readSliceBlob(record.id, name),
    };
  }

  function memorySource(record, files) {
    const byName = new Map(files.map((f) => [f.name, f.blob]));
    return {
      kind: "memory",
      id: record.id,
      name: record.name,
      record,
      manifest: manifestFromRecord(record),
      readSlice: async (name) => {
        const blob = byName.get(name);
        if (!blob) throw new LoadError(`${name} is not in the loaded package.`);
        return blob.type ? blob : new Blob([blob], { type: mimeFor(name) });
      },
    };
  }

  async function folderSource(manifestUrl, sliceUrl) {
    const manifest = await S.loadManifest(manifestUrl);
    return {
      kind: "folder",
      id: null,
      name: manifest.name || "Sample stack (folder)",
      record: null,
      manifest,
      sliceUrl,
      readSlice: async (name) => {
        let res;
        try {
          res = await fetch(sliceUrl(name));
        } catch (err) {
          throw new LoadError(`${name} could not be fetched.`, err.message);
        }
        if (!res.ok) throw new LoadError(`${name} returned HTTP ${res.status}.`);
        return res.blob();
      },
    };
  }

  /** The active cached dataset when there is one, the folder stack otherwise.
   *  A stale active id (dataset deleted, storage cleared) falls back too. */
  async function resolveSource({ manifestUrl, sliceUrl }) {
    const activeId = getActiveId();
    if (activeId) {
      try {
        const record = await getDataset(activeId);
        if (record) return cacheSource(record);
        setActiveId(null);
      } catch {
        /* storage unavailable: use the folder */
      }
    }
    return folderSource(manifestUrl, sliceUrl);
  }

  // --- importing image files ------------------------------------------------------------

  function rasterSize(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  }

  function svgSize(svg) {
    const vb = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { width: vb[2], height: vb[3] };
    const w = parseFloat(svg.getAttribute("width"));
    const h = parseFloat(svg.getAttribute("height"));
    return w > 0 && h > 0 ? { width: w, height: h } : { width: 0, height: 0 };
  }

  /**
   * Turn picked files into an ordered, hashed, not-yet-saved stack.
   * `picked` is [{ file, path }] where path is the name relative to what
   * was chosen ("scan/a.png" for a folder pick). Files in sub-folders and
   * non-images are skipped and reported.
   */
  async function prepareImport(picked, onProgress = () => {}) {
    const skipped = [];
    let nested = 0;
    const candidates = [];
    const depths = picked.map((p) => (p.path || p.file.name).split("/").length);
    const top = Math.min(...depths, Infinity);
    picked.forEach((p, i) => {
      if (depths[i] > top) {
        nested += 1;
        return;
      }
      const name = p.file.name;
      if (name === "manifest.json" || name.startsWith(".")) return;
      if (!IMAGE_EXTENSIONS.test(name)) {
        skipped.push({ name, reason: "not an image" });
        return;
      }
      candidates.push(p.file);
    });

    const seen = new Set();
    const unique = candidates.filter((f) => {
      if (seen.has(f.name)) {
        skipped.push({ name: f.name, reason: "duplicate filename" });
        return false;
      }
      seen.add(f.name);
      return true;
    });
    unique.sort((a, b) => naturalCompare(a.name, b.name));

    const files = [];
    for (let i = 0; i < unique.length; i++) {
      const file = unique[i];
      onProgress(i, unique.length, file.name);
      let blob;
      let dims;
      if (isSvgFilename(file.name)) {
        // Every SVG goes through the one sanitiser; the cleaned markup is
        // what gets stored, hashed and exported.
        const svg = S.sanitizeSvg(await file.text());
        if (!svg) {
          skipped.push({ name: file.name, reason: "not a valid SVG image" });
          continue;
        }
        dims = svgSize(svg);
        blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" });
      } else {
        blob = new Blob([await file.arrayBuffer()], { type: mimeFor(file.name) });
        dims = await rasterSize(blob);
        if (!dims) {
          skipped.push({ name: file.name, reason: "could not be read as an image" });
          continue;
        }
      }
      const hash = await hashBytes(await blob.arrayBuffer());
      files.push({ name: file.name, blob, hash, width: dims.width, height: dims.height });
    }
    onProgress(unique.length, unique.length, "");

    const fileHashes = {};
    files.forEach((f) => { fileHashes[f.name] = f.hash; });
    const names = files.map((f) => f.name);
    const first = files[0];
    const mixedSizes = files.some((f) => f.width !== first.width || f.height !== first.height);
    return {
      files,
      skipped,
      nested,
      mixedSizes,
      bytes: files.reduce((sum, f) => sum + f.blob.size, 0),
      size: first ? Math.max(first.width, first.height) || 400 : 400,
      fileHashes,
      datasetHash: files.length ? datasetHashFor(names, fileHashes) : null,
    };
  }

  function recordFor(prepared, name, extra = {}) {
    return {
      id: prepared.datasetHash,
      name: name || "Untitled stack",
      createdAt: Date.now(),
      size: prepared.size,
      axis: "",
      layers: [],
      files: prepared.files.map((f) => f.name),
      fileHashes: prepared.fileHashes,
      bytes: prepared.bytes,
      ...extra,
    };
  }

  /** Suggest a dataset name from the folder or the filenames' shared start. */
  function suggestName(picked, files) {
    const withFolder = picked.find((p) => p.path && p.path.includes("/"));
    if (withFolder) return withFolder.path.split("/")[0];
    if (!files.length) return "";
    let prefix = files[0].name.replace(/\.[^.]+$/, "");
    files.forEach((f) => {
      while (prefix && !f.name.startsWith(prefix)) prefix = prefix.slice(0, -1);
    });
    return prefix.replace(/[\s._-]*\d*$/, "").replace(/[\s._-]+$/, "").trim();
  }

  // --- zip (store method; our own few lines, no library) -------------------------------

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const yieldToPage = () => new Promise((resolve) => setTimeout(resolve, 0));

  /**
   * Build a zip from [{ name, blob }]. Entries are stored, not compressed:
   * images already are, and the zip is only there to keep the files together.
   * Each blob is read once for its CRC and then referenced, not copied, so a
   * large stack doesn't need twice its size in memory.
   */
  async function zipStore(entries, onProgress = () => {}) {
    if (entries.length > 0xfffe) throw new Error("Too many files for one package.");
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    for (let i = 0; i < entries.length; i++) {
      const { name, blob } = entries[i];
      onProgress(i, entries.length, name);
      const nameBytes = enc.encode(name);
      const crc = crc32(new Uint8Array(await blob.arrayBuffer()));
      const size = blob.size;
      if (offset + size > 0xfffffff0) throw new Error("The package would be larger than 4 GB, which a plain zip can't hold.");

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // UTF-8 names
      local.setUint16(8, 0, true); // stored
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, size, true);
      local.setUint32(22, size, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);
      parts.push(local.buffer, nameBytes, blob);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, dosTime, true);
      cd.setUint16(14, dosDate, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, size, true);
      cd.setUint32(24, size, true);
      cd.setUint16(28, nameBytes.length, true);
      cd.setUint32(42, offset, true);
      central.push(cd.buffer, nameBytes);

      offset += 30 + nameBytes.length + size;
      await yieldToPage();
    }
    onProgress(entries.length, entries.length, "");

    const centralSize = central.reduce((sum, p) => sum + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
  }

  async function inflateRaw(blob) {
    if (typeof DecompressionStream === "undefined") {
      throw new LoadError("This zip is compressed and this browser can't decompress it.", "Re-save the zip without compression (\"store\"), or use a current browser.");
    }
    let stream;
    try {
      stream = blob.stream().pipeThrough(new DecompressionStream("deflate-raw"));
    } catch {
      throw new LoadError("This zip is compressed and this browser can't decompress it.", "Re-save the zip without compression (\"store\"), or use a current browser.");
    }
    return new Response(stream).blob();
  }

  /** True for a zip, by its first bytes - a renamed or extension-less
   *  download is still recognised. */
  async function looksLikeZip(file) {
    if (/\.zip$/i.test(file.name || "")) return true;
    try {
      const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      return head.length === 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
    } catch {
      return false;
    }
  }

  /** Read a zip's entries: Map of name -> { size, read(): Promise<Blob> }. */
  async function unzip(blob) {
    const notZip = () => new LoadError("That file is not a zip package.", "Choose a .zip exported with \"Quiz package\" in the annotator.");
    if (blob.size < 22) throw notZip();
    const tailSize = Math.min(blob.size, 22 + 0xffff);
    const tail = new DataView(await blob.slice(blob.size - tailSize).arrayBuffer());
    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) {
      if (tail.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw notZip();
    const count = tail.getUint16(eocd + 10, true);
    const cdSize = tail.getUint32(eocd + 12, true);
    const cdOffset = tail.getUint32(eocd + 16, true);
    if (count === 0xffff || cdOffset === 0xffffffff) throw new LoadError("This zip uses the zip64 format, which isn't supported.");
    if (cdOffset + cdSize > blob.size) throw notZip();

    const cd = new DataView(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
    const utf8 = new TextDecoder("utf-8");
    const entries = new Map();
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.byteLength || cd.getUint32(p, true) !== 0x02014b50) throw notZip();
      const method = cd.getUint16(p + 10, true);
      const compressedSize = cd.getUint32(p + 20, true);
      const size = cd.getUint32(p + 24, true);
      const nameLen = cd.getUint16(p + 28, true);
      const extraLen = cd.getUint16(p + 30, true);
      const commentLen = cd.getUint16(p + 32, true);
      const localOffset = cd.getUint32(p + 42, true);
      const name = utf8.decode(new Uint8Array(cd.buffer, p + 46, nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith("/")) continue;
      entries.set(name, {
        size,
        async read() {
          const head = new DataView(await blob.slice(localOffset, localOffset + 30).arrayBuffer());
          if (head.byteLength < 30 || head.getUint32(0, true) !== 0x04034b50) throw notZip();
          const start = localOffset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
          const data = blob.slice(start, start + compressedSize);
          if (method === 0) return data;
          if (method === 8) return inflateRaw(data);
          throw new LoadError(`${name} uses a compression method this app can't read.`);
        },
      });
    }
    return entries;
  }

  // --- quiz packages -----------------------------------------------------------------

  const PACKAGE_README = [
    "Radiology Scanner quiz package",
    "==============================",
    "",
    "This zip holds one image stack and the annotations made on it:",
    "",
    "  manifest.json      the ordered list of slices and their SHA-256 hashes",
    "  slices/            the images",
    "  annotations.json   the quiz or showcase",
    "",
    "To use it in the browser: open the quiz page, click Import, and choose",
    "this zip. To keep editing it: open the annotator and do the same.",
    "",
    "To host it (e.g. on Moodle) so students need no import step, run this",
    "in the project folder and upload the folder:",
    "",
    "  python3 scripts/install_package.py <this file>.zip",
    "",
  ].join("\n");

  const slug = (text) => String(text || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "stack";

  function packageFilename(name, exportMode) {
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return `${slug(name)}-${exportMode}-${date}.zip`;
  }

  /**
   * Package a source's images with an annotations export. Hashes are
   * computed from the bytes being packaged, so the package is
   * self-consistent even when the folder manifest carried none.
   * `makeExport(manifest)` returns the annotations payload for that manifest.
   */
  async function buildPackage({ source, makeExport, onProgress = () => {} }) {
    const files = [];
    const fileHashes = {};
    const names = source.manifest.files;
    for (let i = 0; i < names.length; i++) {
      onProgress(i, names.length * 2, names[i]);
      const blob = await source.readSlice(names[i]);
      fileHashes[names[i]] = await hashBytes(await blob.arrayBuffer());
      files.push({ name: `slices/${names[i]}`, blob });
    }
    const manifest = {
      name: source.name,
      size: source.manifest.size,
      sliceCount: names.length,
      axis: source.manifest.axis,
      layers: source.manifest.layers,
      files: names.slice(),
      fileHashes,
      datasetHash: datasetHashFor(names, fileHashes),
    };
    const annotationsText = JSON.stringify(makeExport(manifest), null, 2);
    const entries = [
      { name: "manifest.json", blob: new Blob([JSON.stringify(manifest, null, 2) + "\n"], { type: "application/json" }) },
      { name: "annotations.json", blob: new Blob([annotationsText], { type: "application/json" }) },
      { name: "README.txt", blob: new Blob([PACKAGE_README], { type: "text/plain" }) },
      ...files,
    ];
    const blob = await zipStore(entries, (i, n, name) => onProgress(names.length + Math.round((i / Math.max(n, 1)) * names.length), names.length * 2, name));
    return { blob, manifest, annotationsText };
  }

  const unsafeName = (name) => !name || name.includes("/") || name.includes("\\") || name === "." || name === ".." || name.startsWith(".");

  /**
   * Read a package zip. Returns { record, files, annotationsText, altered }
   * where `altered` lists slices whose bytes don't match the manifest's
   * hashes. Throws LoadError for anything that isn't a package.
   */
  async function readPackage(file, onProgress = () => {}) {
    const entries = await unzip(file);
    const manifestEntry = entries.get("manifest.json");
    if (!manifestEntry) {
      throw new LoadError("That zip has no manifest.json, so it isn't a quiz package.", "Choose a .zip exported with \"Quiz package\" in the annotator.");
    }
    let raw;
    try {
      raw = JSON.parse(await (await manifestEntry.read()).text());
    } catch (err) {
      if (err instanceof LoadError) throw err;
      throw new LoadError("The package's manifest.json is not valid JSON.");
    }
    if (!raw || !Array.isArray(raw.files) || !raw.files.length) throw new LoadError("The package's manifest.json lists no slices.");
    const bad = raw.files.find((n) => typeof n !== "string" || unsafeName(n) || !IMAGE_EXTENSIONS.test(n));
    if (bad !== undefined) throw new LoadError(`The package lists a slice with an unusable name (${String(bad).slice(0, 60)}).`);
    if (new Set(raw.files).size !== raw.files.length) throw new LoadError("The package lists the same slice twice.");

    const files = [];
    const fileHashes = {};
    const altered = [];
    const declared = raw.fileHashes && typeof raw.fileHashes === "object" ? raw.fileHashes : {};
    for (let i = 0; i < raw.files.length; i++) {
      const name = raw.files[i];
      onProgress(i, raw.files.length, name);
      const entry = entries.get(`slices/${name}`);
      if (!entry) throw new LoadError(`The package is missing slices/${name}.`);
      const data = await entry.read();
      const blob = new Blob([data], { type: mimeFor(name) });
      const hash = await hashBytes(await blob.arrayBuffer());
      fileHashes[name] = hash;
      if (declared[name] !== hash) altered.push(name);
      files.push({ name, blob });
    }
    onProgress(raw.files.length, raw.files.length, "");

    let annotationsText = null;
    const annEntry = entries.get("annotations.json");
    if (annEntry) annotationsText = await (await annEntry.read()).text();

    const record = {
      id: datasetHashFor(raw.files, fileHashes),
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 120) : file.name.replace(/\.zip$/i, ""),
      createdAt: Date.now(),
      size: typeof raw.size === "number" && raw.size > 0 ? raw.size : 400,
      axis: typeof raw.axis === "string" ? raw.axis : "",
      layers: Array.isArray(raw.layers) ? raw.layers : [],
      files: raw.files.slice(),
      fileHashes,
      bytes: files.reduce((sum, f) => sum + f.blob.size, 0),
    };
    return { record, files, annotationsText, altered };
  }

  /**
   * Open a quiz package for editing: cache its stack, put its annotations in
   * the annotator's autosave for that stack, and make it the active one.
   * Asks before anything surprising. Resolves to the stored record, or null
   * when the user backed out or something failed (a notice says what).
   */
  async function importPackageForEditing(file) {
    let pkg;
    S.notify("info", `Reading ${file.name}…`, { id: "import", dismissible: false });
    try {
      pkg = await readPackage(file);
    } catch (err) {
      S.notify("error", `Could not import ${file.name}: ${err.message}${err.hint ? ` ${err.hint}` : ""}`, { id: "import" });
      return null;
    }
    S.dismissNotice("import");
    const { record, files, annotationsText, altered } = pkg;
    if (altered.length) {
      const ok = await S.confirmDialog({
        title: "Some images don't match the package's fingerprint",
        message: `${altered.length} of ${files.length} images differ from the hashes in manifest.json (${altered.slice(0, 5).join(", ")}${altered.length > 5 ? ", …" : ""}). Annotations may not line up. Import anyway?`,
        confirmLabel: "Import anyway",
        danger: true,
      });
      if (!ok) return null;
    }

    let incoming = null;
    if (annotationsText) {
      let parsed;
      try {
        parsed = S.parseExportFile(JSON.parse(annotationsText), record.files.length);
      } catch {
        parsed = { error: "annotations.json is not valid JSON" };
      }
      if (parsed.error) {
        S.notify("warn", `The package's annotations were not imported: ${parsed.error}.`, { id: "import" });
      } else {
        incoming = parsed.file;
        const check = S.compareDataset(incoming, manifestFromRecord(record));
        if (check.status !== "match") {
          const ok = await S.confirmDialog({
            title: check.status === "mismatch" ? "These annotations may be for a different image stack" : "These annotations can't be verified",
            message: `${check.message} Import them anyway?`,
            confirmLabel: "Import anyway",
            danger: check.status === "mismatch",
          });
          if (!ok) incoming = null;
        }
      }
    }

    // Work already autosaved for this exact stack wins unless told otherwise.
    const store = S.createStore(`annotator:${record.id}:v3`);
    const held = store.read();
    let useIncoming = !!incoming;
    if (incoming && Array.isArray(held) && held.length) {
      useIncoming = await S.confirmDialog({
        title: "This browser already has work on this stack",
        message: `${held.length} annotation${held.length === 1 ? " is" : "s are"} autosaved here for these images; the package holds ${incoming.annotations.length}. Which do you want to continue with?`,
        confirmLabel: "Use the package's",
        cancelLabel: "Keep autosaved",
      });
    }

    const stored = { ...record, quizText: annotationsText || undefined };
    try {
      await saveDataset(stored, files);
    } catch (err) {
      S.notify("error", `The package could not be stored: ${storageErrorMessage(err)} Nothing was changed.`, { id: "import" });
      return null;
    }
    if (useIncoming && !store.write(incoming.annotations)) {
      S.notify("error", "The images were stored but the annotations could not be saved in this browser.", { id: "import" });
      return null;
    }
    setActiveId(record.id);
    return stored;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function formatBytes(n) {
    if (!Number.isFinite(n)) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10485760 ? 1 : 0)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }

  // --- header switcher shared by the annotator and quiz ---------------------------------

  /**
   * Fill a <select> with the cached datasets, the folder stack, and a link to
   * the start page. Picking one makes it active and reloads the page.
   */
  async function wireDatasetSwitcher(select, source, { startUrl }) {
    let datasets = [];
    try {
      datasets = await listDatasets();
    } catch {
      /* storage blocked: only the folder entry is offered */
    }
    select.innerHTML = "";
    const add = (value, text, selected) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = text;
      o.selected = !!selected;
      select.appendChild(o);
    };
    const count = (n) => `${n} slice${n === 1 ? "" : "s"}`;
    if (source.kind === "memory") add("memory", `${source.name} · ${count(source.manifest.sliceCount)} (not saved)`, true);
    datasets.forEach((d) => add(`cache:${d.id}`, `${d.name} · ${count(d.files.length)}`, source.kind === "cache" && source.id === d.id));
    add("folder", source.kind === "folder" ? `${source.name} · ${count(source.manifest.sliceCount)}` : "Sample stack (folder)", source.kind === "folder");
    add("start", "Choose images…");
    select.addEventListener("change", () => {
      const v = select.value;
      if (v === "start") {
        location.href = startUrl;
        return;
      }
      if (v === "memory") return;
      setActiveId(v === "folder" ? null : v.slice(6));
      location.reload();
    });
  }

  Object.assign(S, {
    naturalCompare,
    hashBytes,
    datasetHashFor,
    listDatasets,
    getDataset,
    saveDataset,
    updateDataset,
    deleteDataset,
    readSliceBlob,
    storageEstimate,
    storageErrorMessage,
    getActiveId,
    setActiveId,
    manifestFromRecord,
    cacheSource,
    memorySource,
    folderSource,
    resolveSource,
    prepareImport,
    recordFor,
    suggestName,
    zipStore,
    unzip,
    looksLikeZip,
    buildPackage,
    readPackage,
    importPackageForEditing,
    packageFilename,
    downloadBlob,
    formatBytes,
    wireDatasetSwitcher,
  });
})();
