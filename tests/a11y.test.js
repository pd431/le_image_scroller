#!/usr/bin/env node
/* Visual-accessibility checks for both tools.
 *
 * For every browser engine available (Chromium always; Firefox when its
 * Playwright build is installed), every viewport in VIEWPORTS and every UI
 * state in STATES, this checks that each interactive element:
 *   - is reachable: a hit test at its centre lands on it (nothing covers it)
 *     once it is scrolled into view, and the page never scrolls sideways;
 *   - is big enough: at least 24x24 CSS px (WCAG 2.5.8), 32x32 on touch;
 *   - has an accessible name;
 *   - does not overlap another interactive element;
 *   - still satisfies the above at 200% browser zoom (emulated as half the
 *     viewport at device scale factor 2, which is what zoom does to layout);
 * and that keyboard focus is visible (an outline with non-zero width).
 *
 * Run: node tests/a11y.test.js [--grep text]
 * Firefox: set PLAYWRIGHT_BROWSERS_PATH to a folder where
 * `npx playwright install firefox` has put it.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const playwright = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml",
};

const VIEWPORTS = [
  { name: "desktop-1920", width: 1920, height: 1080 },
  { name: "laptop-1536", width: 1536, height: 864 },
  { name: "laptop-short-1366", width: 1366, height: 650 },
  { name: "desktop-1280", width: 1280, height: 800 },
  { name: "tablet-landscape-1024", width: 1024, height: 768, touch: true },
  { name: "tablet-portrait-820", width: 820, height: 1180, touch: true },
  { name: "phone-390", width: 390, height: 844, touch: true },
];

// --- static server over a copy of the site ------------------------------------------

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (["node_modules", ".git", "tests"].includes(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function serve() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-a11y-"));
  copyDir(ROOT, dir);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "data/slices/manifest.json"), "utf8"));
  // A quiz file with one of each type, one spanning several slices.
  fs.writeFileSync(path.join(dir, "quiz/annotations.json"), JSON.stringify({
    version: 3, exportMode: "quiz", quizMode: "full", datasetHash: manifest.datasetHash,
    dataset: { size: manifest.size, sliceCount: manifest.sliceCount, axis: manifest.axis },
    annotations: [
      { id: "a", type: "pin", sliceFrom: 10, sliceTo: 14, x: 0.5, y: 0.5, title: "Thing A", description: "About A" },
      { id: "b", type: "label", sliceFrom: 3, sliceTo: 3, x: 0.4, y: 0.6, text: "Label B" },
      { id: "c", type: "mcq", sliceFrom: 5, sliceTo: 5, x: 0.5, y: 0.5, question: "Which?", options: ["One", "Two"], answer: "Two" },
    ],
  }));
  fs.writeFileSync(path.join(dir, "quiz/showcase.json"), JSON.stringify({
    version: 3, exportMode: "showcase", datasetHash: manifest.datasetHash,
    dataset: { size: manifest.size, sliceCount: manifest.sliceCount, axis: manifest.axis },
    annotations: [{ id: "a", type: "pin", sliceFrom: 10, sliceTo: 14, x: 0.5, y: 0.5, title: "Thing A", description: "About A" }],
  }));
  const server = http.createServer((req, res) => {
    const file = path.join(dir, decodeURIComponent(req.url.split("?")[0]));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    dir,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// --- UI states to check ---------------------------------------------------------------

async function stageClick(page, fx, fy) {
  await page.evaluate(() => document.getElementById("stage").scrollIntoView({ block: "center" }));
  const box = await (await page.$("#stage")).boundingBox();
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
}

async function setSlider(page, value) {
  await page.$eval("#scrub", (e, v) => { e.value = v; e.dispatchEvent(new Event("input")); }, String(value));
  await page.waitForFunction((i) => document.getElementById("readout").textContent.startsWith(`${i} /`), value);
}

const STATES = [
  {
    name: "annotator: empty",
    url: "/annotator/index.html",
    setup: async (page) => { await page.waitForSelector("#svgHost svg"); },
  },
  {
    name: "annotator: multi-slice annotation, editing one slice",
    url: "/annotator/index.html",
    setup: async (page) => {
      await page.waitForSelector("#svgHost svg");
      await page.click('.palette-item[data-type="pin"]');
      await stageClick(page, 0.5, 0.5);
      await page.waitForSelector("#f-to");
      await page.fill("#f-to", "4");
      await page.$eval("#f-to", (e) => e.dispatchEvent(new Event("change")));
      await page.waitForSelector(".slice-chip");
      await page.click('input[name="editScope"][value="slice"]');
      await page.$eval("#f-radius", (e) => { e.value = 20; e.dispatchEvent(new Event("input")); });
      await page.waitForSelector("#useOnAllBtn");
    },
  },
  {
    name: "annotator: drawing a shape",
    url: "/annotator/index.html",
    setup: async (page) => {
      await page.waitForSelector("#svgHost svg");
      await page.click('.palette-item[data-type="label"]');
      await stageClick(page, 0.5, 0.5);
      await page.waitForSelector("#f-text");
      await page.click('input[name="tolMode"][value="polygon"]');
      await page.click("#drawShapeBtn");
      await stageClick(page, 0.3, 0.3);
      await page.waitForSelector("#undoPointBtn:not([disabled])");
    },
  },
  {
    name: "annotator: export dialog",
    url: "/annotator/index.html",
    setup: async (page) => {
      await page.waitForSelector("#svgHost svg");
      await page.click("#exportBtn");
      await page.waitForSelector("#exportDownloadBtn");
    },
  },
  {
    name: "quiz: start screen",
    url: "/quiz/index.html",
    setup: async (page) => { await page.waitForSelector("#startBtn"); },
  },
  {
    name: "quiz: item with a wrong placement and hints",
    url: "/quiz/index.html",
    setup: async (page) => {
      await page.waitForSelector("#startBtn");
      await page.click("#startBtn");
      await page.waitForSelector("#checkBtn");
      await stageClick(page, 0.2, 0.2);
      await page.click("#checkBtn");
      await page.waitForSelector(".outcome-banner.incorrect");
      await setSlider(page, 12);
      await stageClick(page, 0.1, 0.1);
      await page.click("#checkBtn");
      await page.waitForSelector(".tolerance-layer .tolerance.reveal");
    },
  },
  {
    name: "quiz: MCQ item",
    url: "/quiz/index.html",
    setup: async (page) => {
      await page.waitForSelector("#startBtn");
      await page.click("#startBtn");
      await page.waitForSelector("#targetsList li");
      await page.click('#targetsList li[data-id="c"]');
      await page.waitForSelector('input[name="choice"]');
    },
  },
  {
    name: "quiz: summary",
    url: "/quiz/index.html",
    setup: async (page) => {
      await page.waitForSelector("#startBtn");
      await page.click("#startBtn");
      await page.waitForSelector("#summaryBtn:not([disabled])");
      await page.click("#summaryBtn");
      await page.waitForSelector(".summary-list");
    },
  },
  {
    name: "quiz: showcase",
    url: "/quiz/index.html",
    setup: async (page, site) => {
      await page.waitForSelector("#startBtn");
      await page.setInputFiles("#importFile", path.join(site.dir, "quiz/showcase.json"));
      await page.waitForSelector("#showcaseList li");
      await page.click("#showcaseList li");
      await page.waitForSelector(".marker.showcase");
    },
  },
];

// --- the checks, run inside the page --------------------------------------------------

const INTERACTIVE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [role="button"], .marker, .palette-item, .annotation-list li, .summary-list li button';

function auditInPage({ minSize, selector }) {
  const problems = [];
  const doc = document.documentElement;

  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || el.hidden) return false;
    // Content of a closed <details> keeps a box in Chromium but is not shown.
    const closed = el.closest("details:not([open])");
    if (closed && !(el.tagName === "SUMMARY" && el.parentElement === closed)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const describe = (el) => {
    const id = el.id ? `#${el.id}` : "";
    const cls = el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
    const text = (el.textContent || "").trim().slice(0, 25);
    return `${el.tagName.toLowerCase()}${id}${cls}${text ? ` "${text}"` : ""}`;
  };
  const accessibleName = (el) => {
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");
    const by = el.getAttribute("aria-labelledby");
    if (by) return by.split(/\s+/).map((i) => (document.getElementById(i) || {}).textContent || "").join(" ").trim();
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab && lab.textContent.trim()) return lab.textContent.trim();
    }
    const wrap = el.closest("label");
    if (wrap && wrap.textContent.trim()) return wrap.textContent.trim();
    if (el.title) return el.title;
    if (el.placeholder) return el.placeholder;
    if (el.alt) return el.alt;
    return (el.textContent || "").trim();
  };

  // The box to measure for a native radio/checkbox is its label: the label is
  // the click target and is sized to the minimum.
  const targetBox = (el) => {
    if (el.matches('input[type="radio"], input[type="checkbox"]')) {
      const lab = el.closest("label");
      if (lab) return lab.getBoundingClientRect();
    }
    return el.getBoundingClientRect();
  };

  const els = Array.from(document.querySelectorAll(selector)).filter(visible);
  const backdropOpen = document.querySelector(".modal-backdrop.open");
  const inScope = backdropOpen ? els.filter((e) => backdropOpen.contains(e)) : els;

  if (doc.scrollWidth > doc.clientWidth + 1) {
    problems.push(`page scrolls sideways (${doc.scrollWidth} > ${doc.clientWidth})`);
  }

  // Sizes, names and page-coordinate boxes are measured in one pass before
  // anything is scrolled, so the overlap test compares a consistent layout.
  const boxes = [];
  for (const el of inScope) {
    const name = accessibleName(el);
    if (!name) problems.push(`no accessible name: ${describe(el)}`);
    const box = targetBox(el);
    if (box.width + 0.5 < minSize || box.height + 0.5 < minSize) {
      problems.push(`too small (${Math.round(box.width)}x${Math.round(box.height)} < ${minSize}): ${describe(el)}`);
    }
    const r = el.getBoundingClientRect();
    boxes.push({ el, r: { left: r.left + window.scrollX, top: r.top + window.scrollY, right: r.right + window.scrollX, bottom: r.bottom + window.scrollY } });
  }

  for (const el of inScope) {
    if (el.disabled) continue;
    el.scrollIntoView({ block: "center", inline: "nearest" });
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) {
      problems.push(`cannot be scrolled into view: ${describe(el)}`);
      continue;
    }
    const hit = document.elementFromPoint(cx, cy);
    const ok = hit && (el.contains(hit) || hit.contains(el));
    if (!ok) problems.push(`covered by ${hit ? describe(hit) : "nothing"}: ${describe(el)}`);
  }

  // Overlap between distinct interactive elements. Markers may legitimately
  // sit on top of each other when zones are close, so marker pairs are skipped.
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      if (a.el.classList.contains("marker") && b.el.classList.contains("marker")) continue;
      const overlapX = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const overlapY = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (overlapX > 1 && overlapY > 1) problems.push(`overlap: ${describe(a.el)} and ${describe(b.el)}`);
    }
  }

  window.scrollTo(0, 0);
  return { problems, count: inScope.length };
}

async function focusAudit(page) {
  const problems = [];
  const seen = new Set();
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const ring = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none";
      return { key: el.tagName + "#" + el.id + "." + el.className, ring };
    });
    if (!info) break;
    if (seen.has(info.key)) break;
    seen.add(info.key);
    if (!info.ring) problems.push(`no visible focus ring: ${info.key}`);
  }
  return problems;
}

// --- runner -----------------------------------------------------------------------------

(async () => {
  const grep = process.argv.includes("--grep") ? process.argv[process.argv.indexOf("--grep") + 1] : null;
  const site = await serve();
  const engines = [];
  engines.push({ name: "chromium", browser: await playwright.chromium.launch() });
  try {
    engines.push({ name: "firefox", browser: await playwright.firefox.launch() });
  } catch (err) {
    console.log("  note: Firefox is not installed for Playwright here; skipping it. " +
      "Install with `npx playwright install firefox` (set PLAYWRIGHT_BROWSERS_PATH if needed).");
  }

  let failures = 0;
  let checks = 0;
  for (const { name: engine, browser } of engines) {
    for (const vp of VIEWPORTS) {
      for (const st of STATES) {
        const label = `${engine} · ${vp.name} · ${st.name}`;
        if (grep && !label.includes(grep)) continue;
        const runState = async (opts, minSize) => {
          const context = await browser.newContext(opts);
          const page = await context.newPage();
          const pageErrors = [];
          page.on("pageerror", (e) => pageErrors.push(e.message));
          try {
            await page.goto(`${site.base}${st.url}`);
            await st.setup(page, site);
            const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
            const audit = await page.evaluate(auditInPage, { minSize: coarse ? Math.max(minSize, 32) : minSize, selector: INTERACTIVE });
            const focus = st.name.includes("dialog") ? [] : await focusAudit(page);
            return { count: audit.count, problems: [...audit.problems, ...focus, ...pageErrors.map((e) => `page error: ${e}`)] };
          } finally {
            await context.close();
          }
        };
        checks += 1;
        try {
          const normal = await runState({ viewport: { width: vp.width, height: vp.height }, hasTouch: !!vp.touch }, 24);
          // WCAG 1.4.10 asks for reflow down to 320 CSS px; a phone at 200%
          // is narrower than that, so the zoom pass is skipped there.
          const zoomed = vp.width / 2 >= 320
            ? await runState({ viewport: { width: Math.round(vp.width / 2), height: Math.round(vp.height / 2) }, deviceScaleFactor: 2, hasTouch: !!vp.touch }, 24)
            : { problems: [] };
          const problems = [...normal.problems, ...zoomed.problems.map((p) => `at 200% zoom: ${p}`)];
          if (problems.length) {
            failures += 1;
            console.log(`  FAIL ${label} (${normal.count} elements)`);
            Array.from(new Set(problems)).slice(0, 12).forEach((p) => console.log(`       - ${p}`));
          } else {
            console.log(`  ok   ${label} (${normal.count} elements)`);
          }
        } catch (err) {
          failures += 1;
          console.log(`  FAIL ${label}\n       ${err.message.split("\n")[0]}`);
        }
      }
    }
  }
  for (const e of engines) await e.browser.close();
  await site.close();
  console.log(`\n${checks - failures} of ${checks} checks passed across ${engines.map((e) => e.name).join(", ")}`);
  process.exit(failures ? 1 : 0);
})();
