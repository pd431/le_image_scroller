#!/usr/bin/env node
/* End-to-end tests for the annotator and quiz, driven by Playwright.
 *
 * Each test serves a fresh copy of the project from a temp folder over a
 * local HTTP server (so it can tamper with slices and annotation files), and
 * runs headless Chromium against it. No test framework: a tiny runner below
 * keeps the dependency list to Playwright alone.
 *
 * Run: npm test   (or: node tests/e2e.test.js [--grep text])
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");
const zlib = require("zlib");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
};

// --- fixture: a disposable copy of the site ---------------------------------------

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

async function makeSite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-e2e-"));
  copyDir(ROOT, dir);
  const delays = new Map(); // url path -> ms
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    const file = path.join(dir, urlPath);
    const send = () => {
      if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      fs.createReadStream(file).pipe(res);
    };
    const delay = delays.get(urlPath);
    if (delay) setTimeout(send, delay);
    else send();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    dir,
    base,
    delays,
    write(rel, content) { fs.writeFileSync(path.join(dir, rel), content); },
    read(rel) { return fs.readFileSync(path.join(dir, rel), "utf8"); },
    json(rel) { return JSON.parse(this.read(rel)); },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function quizFile(site, annotations, extra = {}) {
  const manifest = site.json("data/slices/manifest.json");
  return JSON.stringify({
    version: 3,
    exportMode: "quiz",
    quizMode: "full",
    datasetHash: manifest.datasetHash,
    dataset: { size: manifest.size, sliceCount: manifest.sliceCount, axis: manifest.axis },
    annotations,
    ...extra,
  });
}

const SCRIPTED_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
  <script>window.__svgScript = 1;</script>
  <image href="x" onerror="window.__svgHandler = 1" />
  <polygon data-layer="skin" points="100,100 300,100 300,300 100,300" fill="red" onclick="window.__svgClick = 1" />
  <foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="window.__svgForeign = 1" /></body></foreignObject>
  <a href="javascript:window.__svgLink=1"><circle cx="200" cy="200" r="10" /></a>
</svg>`;

// --- tiny runner -----------------------------------------------------------------------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

async function stageClick(page, fx, fy) {
  const box = await (await page.$("#stage")).boundingBox();
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
}

async function setSlider(page, value) {
  await page.$eval("#scrub", (e, v) => { e.value = v; e.dispatchEvent(new Event("input")); }, String(value));
}

async function waitStep(page, text) {
  await page.waitForFunction((t) => (document.querySelector("#inspector .step") || {}).textContent?.includes(t), text);
}

async function waitReadout(page, index) {
  await page.waitForFunction((i) => document.getElementById("readout").textContent.startsWith(`${i} /`), index);
}

// --- tests ---------------------------------------------------------------------------------

test("scripted SVG slice is neutralised but layer detection still works", async ({ page, site }) => {
  site.write("data/slices/slice-001.svg", SCRIPTED_SVG);
  await page.goto(`${site.base}/annotator/index.html`);
  await page.waitForSelector("#svgHost svg");
  await page.click('.palette-item[data-type="label"]');
  await stageClick(page, 0.5, 0.5);
  await page.waitForSelector(".marker");
  const flags = await page.evaluate(() => ({
    script: window.__svgScript, handler: window.__svgHandler, click: window.__svgClick, foreign: window.__svgForeign,
    polygons: document.querySelectorAll("#svgHost polygon[data-layer]").length,
    scripts: document.querySelectorAll("#svgHost script, #svgHost foreignObject, #svgHost a, #svgHost image").length,
  }));
  assert.strictEqual(flags.script, undefined, "inline <script> ran");
  assert.strictEqual(flags.handler, undefined, "onerror handler ran");
  assert.strictEqual(flags.foreign, undefined, "foreignObject content ran");
  assert.strictEqual(flags.scripts, 0, "unsafe elements survived");
  assert.strictEqual(flags.polygons, 1, "data-layer polygon was dropped");
  assert.strictEqual(await page.textContent(".annotation-list .layer-tag"), "skin");

  await page.goto(`${site.base}/quiz/index.html`);
  await page.waitForSelector("#svgHost svg");
  assert.strictEqual(await page.evaluate(() => window.__svgScript || window.__svgHandler), undefined);
});

test("raster slices display as images", async ({ page, site }) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  site.write("data/slices/slice-001.png", png);
  const manifest = site.json("data/slices/manifest.json");
  manifest.files[0] = "slice-001.png";
  site.write("data/slices/manifest.json", JSON.stringify(manifest));
  await page.goto(`${site.base}/annotator/index.html`);
  await page.waitForSelector("#svgHost img");
  assert.ok((await page.getAttribute("#svgHost img", "src")).endsWith("slice-001.png"));
});

test("import rejects markup in a numeric field and renders nothing from it", async ({ page, site }) => {
  await page.goto(`${site.base}/annotator/index.html`);
  await page.waitForSelector("#svgHost svg");
  const bad = quizFile(site, [
    { id: "a", type: "label", sliceIndex: '<img src=x onerror="window.__idx=1">', x: 0.5, y: 0.5, text: "x" },
    { id: "b", type: "pin", sliceFrom: 2, sliceTo: 2, x: 0.5, y: 0.5, title: '<img src=x onerror="window.__title=1">' },
  ]);
  await page.setInputFiles("#importFile", { name: "annotations.json", mimeType: "application/json", buffer: Buffer.from(bad) });
  await page.waitForSelector(".notice.warn");
  const notice = await page.textContent(".notice.warn");
  assert.match(notice, /entry 1: slice index is not a whole number/);
  assert.strictEqual(await page.evaluate(() => window.__idx || window.__title), undefined, "markup from the file executed");
  await setSlider(page, 2);
  await waitReadout(page, 2);
  assert.ok((await page.textContent("#allAnnotationList")).includes("<img"), "title should be shown as literal text");
});

test("fast scrubbing settles on the requested slice", async ({ page, site }) => {
  site.delays.set("/data/slices/slice-002.svg", 700);
  await page.goto(`${site.base}/annotator/index.html`);
  await page.waitForSelector("#svgHost svg");
  await setSlider(page, 2);
  await setSlider(page, 3);
  await waitReadout(page, 3);
  await page.waitForTimeout(1000); // let the slow slice-2 response arrive
  const shown = await page.evaluate(() => document.querySelector("#svgHost svg polygon[data-layer=skin]").getAttribute("points"));
  const slice3 = site.read("data/slices/slice-003.svg");
  assert.ok(slice3.includes(shown.slice(0, 40)), "stage shows a different slice than the readout");
  assert.strictEqual(await page.textContent("#readout"), "3 / 40");
  await page.click('.palette-item[data-type="pin"]');
  await stageClick(page, 0.5, 0.5);
  await page.waitForSelector(".marker");
  assert.match(await page.textContent("#inspector .meta"), /^Slice 3 /);
});

test("quiz warns when the bundled file is for a different stack and still loads", async ({ page, site }) => {
  site.write("quiz/annotations.json", quizFile(site, [{ id: "a", type: "label", sliceFrom: 1, sliceTo: 1, x: 0.5, y: 0.5, text: "Thing" }], { datasetHash: "0".repeat(64) }));
  await page.goto(`${site.base}/quiz/index.html`);
  await page.waitForSelector(".notice.warn");
  assert.match(await page.textContent(".notice.warn"), /different set of slice images/);
  assert.match(await page.textContent("#datasetInfo"), /1 item/);
});

test("annotator import against a different stack asks first, and cancel keeps things as they were", async ({ page, site }) => {
  await page.goto(`${site.base}/annotator/index.html`);
  await page.waitForSelector("#svgHost svg");
  const file = quizFile(site, [{ id: "a", type: "label", sliceFrom: 1, sliceTo: 1, x: 0.5, y: 0.5, text: "Other" }], { datasetHash: "1".repeat(64) });
  await page.setInputFiles("#importFile", { name: "x.json", mimeType: "application/json", buffer: Buffer.from(file) });
  await page.waitForSelector(".modal");
  assert.match(await page.textContent(".modal h3"), /different image stack/);
  await page.click("#confirmCancelBtn");
  assert.strictEqual(await page.textContent("#totalAnnCount"), "0");
  await page.setInputFiles("#importFile", { name: "x.json", mimeType: "application/json", buffer: Buffer.from(file) });
  await page.waitForSelector(".modal");
  await page.click("#confirmOkBtn");
  await page.waitForFunction(() => document.getElementById("totalAnnCount").textContent === "1");
});

test("older export without a hash can be imported after a notice", async ({ page, site }) => {
  await page.goto(`${site.base}/annotator/index.html`);
  await page.waitForSelector("#svgHost svg");
  const v2 = JSON.stringify({ version: 2, exportMode: "quiz", annotations: [{ id: "a", type: "label", sliceIndex: 4, x: 0.5, y: 0.5, text: "Old" }] });
  await page.setInputFiles("#importFile", { name: "old.json", mimeType: "application/json", buffer: Buffer.from(v2) });
  await page.waitForSelector(".modal");
  assert.match(await page.textContent(".modal h3"), /can't be verified/);
  await page.click("#confirmOkBtn");
  await page.waitForFunction(() => document.getElementById("totalAnnCount").textContent === "1");
  assert.match(await page.textContent("#allAnnotationList"), /#4/);
});

test("two copies with different stacks on one host keep separate autosave", async ({ page, site }) => {
  // Second copy: same site, one slice renamed, manifest rebuilt by hand.
  const copy = path.join(site.dir, "copyB");
  copyDir(ROOT, copy);
  const m = JSON.parse(fs.readFileSync(path.join(copy, "data/slices/manifest.json"), "utf8"));
  m.datasetHash = "f".repeat(64);
  fs.writeFileSync(path.join(copy, "data/slices/manifest.json"), JSON.stringify(m));

  await page.goto(`${site.base}/annotator/index.html`);
  await page.waitForSelector("#svgHost svg");
  await page.click('.palette-item[data-type="label"]');
  await stageClick(page, 0.5, 0.5);
  await page.waitForSelector(".marker");

  await page.goto(`${site.base}/copyB/annotator/index.html`);
  await page.waitForSelector("#svgHost svg");
  assert.strictEqual(await page.textContent("#totalAnnCount"), "0");
  await page.goto(`${site.base}/annotator/index.html`);
  await page.waitForSelector("#svgHost svg");
  assert.strictEqual(await page.textContent("#totalAnnCount"), "1");
});

test("work saved by the previous version is offered for recovery", async ({ page, site }) => {
  await page.goto(`${site.base}/annotator/index.html`);
  await page.waitForSelector("#svgHost svg");
  await page.evaluate(() => localStorage.setItem("annotator:apple:v2", JSON.stringify([{ id: "old", type: "pin", sliceIndex: 7, x: 0.3, y: 0.3, title: "Legacy" }])));
  await page.reload();
  await page.waitForSelector(".modal");
  assert.match(await page.textContent(".modal"), /Recover earlier annotations/);
  await page.click("#confirmOkBtn");
  await page.waitForFunction(() => document.getElementById("totalAnnCount").textContent === "1");
  assert.match(await page.textContent("#allAnnotationList"), /Legacy/);
  assert.strictEqual(await page.evaluate(() => localStorage.getItem("annotator:apple:v2")), null);
});

test("blocked storage shows a heads-up in the annotator", async ({ page, site }) => {
  await page.addInitScript(() => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    Object.defineProperty(window, "localStorage", { get: () => broken });
  });
  await page.goto(`${site.base}/annotator/index.html`);
  await page.waitForSelector(".notice.warn");
  assert.match(await page.textContent(".notice.warn"), /autosave is off/i);
  await page.click('.palette-item[data-type="label"]');
  await stageClick(page, 0.5, 0.5);
  await page.waitForSelector(".marker");
  assert.strictEqual(await page.$$eval(".notice.warn", (n) => n.length), 1, "banner should not duplicate");
});

test("manifest missing shows a clear error instead of Loading…", async ({ page, site }) => {
  fs.unlinkSync(path.join(site.dir, "data/slices/manifest.json"));
  await page.goto(`${site.base}/annotator/index.html`);
  await page.waitForSelector(".notice.error");
  assert.match(await page.textContent(".notice.error"), /HTTP 404/);
  assert.strictEqual(await page.textContent("#datasetInfo"), "Failed to load");
});

test("a missing slice file shows a placeholder and the rest still work", async ({ page, site }) => {
  fs.unlinkSync(path.join(site.dir, "data/slices/slice-002.svg"));
  await page.goto(`${site.base}/annotator/index.html`);
  await page.waitForSelector("#svgHost svg");
  await setSlider(page, 2);
  await page.waitForSelector(".slice-missing");
  assert.match(await page.textContent(".slice-missing"), /slice-002\.svg/);
  await setSlider(page, 3);
  await page.waitForSelector("#svgHost svg");
});

test("a zone spanning several slices grades on each slice, with a per-slice override", async ({ page, site }) => {
  site.write("quiz/annotations.json", quizFile(site, [{
    id: "core", type: "label", sliceFrom: 16, sliceTo: 21, x: 0.5, y: 0.5, text: "Core",
    tolerance: { mode: "radius", radius: 0.05 },
    overrides: { 19: { x: 0.2, y: 0.2, tolerance: { mode: "radius", radius: 0.05 } } },
  }]));
  await page.goto(`${site.base}/quiz/index.html`);
  await page.waitForSelector("#startBtn");
  await page.click("#startBtn");
  await setSlider(page, 20);
  await waitReadout(page, 20);
  await stageClick(page, 0.5, 0.5);
  await page.click("#checkBtn");
  await page.waitForSelector(".outcome-banner.correct");

  await page.click("#nextBtn"); // finish -> summary
  await page.click('[data-retry="core"]');
  await setSlider(page, 19);
  await waitReadout(page, 19);
  await stageClick(page, 0.5, 0.5); // default zone does not apply on 19
  await page.click("#checkBtn");
  await page.waitForSelector(".outcome-banner.incorrect");
  assert.match(await page.textContent(".outcome-banner"), /Right slice, but not the right spot/);
  await stageClick(page, 0.2, 0.2);
  await page.click("#checkBtn");
  await page.waitForSelector(".outcome-banner.correct");
});

test("guided flow: one item at a time, escalating hints, skip and summary", async ({ page, site }) => {
  site.write("quiz/annotations.json", quizFile(site, [
    { id: "a", type: "pin", sliceFrom: 10, sliceTo: 12, x: 0.5, y: 0.5, title: "Thing A", description: "About A", tolerance: { mode: "radius", radius: 0.05 } },
    { id: "b", type: "mcq", sliceFrom: 5, sliceTo: 5, x: 0.5, y: 0.5, question: "Which?", options: ["One", "Two"], answer: "Two" },
  ]));
  await page.goto(`${site.base}/quiz/index.html`);
  await page.waitForSelector("#startBtn");
  assert.match(await page.textContent("#inspector"), /2 items/);
  await page.click("#startBtn");
  await waitStep(page, "Item 1 of 2");

  // No hint before the first check in a full-challenge quiz.
  assert.strictEqual(await page.$$eval("#hintTicks .tick", (t) => t.length), 0);
  // Miss on the wrong slice: told it is the wrong slice, and the range hint appears.
  await stageClick(page, 0.5, 0.5);
  await page.click("#checkBtn");
  await page.waitForSelector(".outcome-banner.incorrect");
  assert.match(await page.textContent(".outcome-banner"), /marker is on slice 1; the feature is on slices 10–12/);
  assert.strictEqual(await page.$$eval("#hintTicks .tick", (t) => t.length), 1);
  // Second miss on the right slice, wrong spot: zone gets outlined.
  await setSlider(page, 11);
  await waitReadout(page, 11);
  await stageClick(page, 0.1, 0.1);
  await page.click("#checkBtn");
  await page.waitForSelector(".tolerance-layer .tolerance.reveal");
  assert.match(await page.textContent(".outcome-banner"), /Right slice/);
  // Third miss unlocks "Show me".
  await stageClick(page, 0.9, 0.9);
  await page.click("#checkBtn");
  await page.waitForSelector("#showMeBtn");
  await page.click("#skipBtn");
  await waitStep(page, "Item 2 of 2");

  await page.check('input[name="choice"][value="One"]');
  await page.click("#checkBtn");
  await page.waitForSelector(".outcome-banner.incorrect");
  await page.check('input[name="choice"][value="Two"]');
  await page.click("#checkBtn");
  await page.waitForSelector(".outcome-banner.correct");
  await page.click("#nextBtn"); // wraps back to the skipped item
  await waitStep(page, "Item 1 of 2");
  await page.click("#showMeBtn");
  await page.waitForSelector(".status-icon.revealed");
  await page.click("#nextBtn");
  await page.waitForSelector(".summary-list");
  assert.match(await page.textContent(".summary-total"), /1 of 2 correct/);

  // Progress survives a reload.
  await page.reload();
  await page.waitForSelector(".summary-list");
  assert.match(await page.textContent(".summary-total"), /1 of 2 correct/);
});

test("showcase export lists every annotation with its slice range", async ({ page, site }) => {
  site.write("quiz/annotations.json", quizFile(site, [
    { id: "a", type: "pin", sliceFrom: 10, sliceTo: 12, x: 0.5, y: 0.5, title: "Span", description: "d" },
  ], { exportMode: "showcase" }));
  await page.goto(`${site.base}/quiz/index.html`);
  await page.waitForSelector("#showcaseList li");
  assert.match(await page.textContent("#showcaseList"), /#10–12/);
  await page.click("#showcaseList li");
  await waitReadout(page, 10);
  await page.waitForSelector(".marker.showcase");
  assert.match(await page.textContent("#inspector"), /Slices 10–12/);
});

test("annotator: range, per-slice override and export carry through to the file", async ({ page, site }) => {
  await page.goto(`${site.base}/annotator/index.html`);
  await page.waitForSelector("#svgHost svg");
  await page.click('.palette-item[data-type="pin"]');
  await stageClick(page, 0.5, 0.5);
  await page.waitForSelector("#f-title");
  await page.fill("#f-title", "Spanner");
  await page.fill("#f-to", "4");
  await page.$eval("#f-to", (e) => e.dispatchEvent(new Event("change")));
  await page.waitForFunction(() => /Slices 1–4/.test(document.querySelector("#inspector .meta").textContent));
  await setSlider(page, 3);
  await waitReadout(page, 3);
  await page.click('input[name="editScope"][value="slice"]');
  await page.$eval("#f-radius", (e) => { e.value = 25; e.dispatchEvent(new Event("input")); });
  await page.waitForSelector(".marker.overridden");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    (async () => {
      await page.click("#exportBtn");
      await page.check('input[name="exportWhat"][value="json"]');
      await page.click("#exportDownloadBtn");
    })(),
  ]);
  const text = fs.readFileSync(await download.path(), "utf8");
  const exported = JSON.parse(text);
  assert.strictEqual(exported.version, 3);
  assert.strictEqual(exported.datasetHash, site.json("data/slices/manifest.json").datasetHash);
  const ann = exported.annotations[0];
  assert.deepStrictEqual([ann.sliceFrom, ann.sliceTo], [1, 4]);
  assert.strictEqual(ann.overrides["3"].tolerance.radius, 0.25);
  assert.strictEqual(ann.tolerance.radius, 0.06, "default zone must be untouched");
});

test("per-slice shapes: draw on one slice, copy to a neighbour, use on all, reset", async ({ page, site }) => {
  await page.goto(`${site.base}/annotator/index.html`);
  await page.waitForSelector("#svgHost svg");
  await page.click('.palette-item[data-type="pin"]');
  await stageClick(page, 0.5, 0.5);
  await page.waitForSelector("#f-to");
  await page.fill("#f-to", "21");
  await page.$eval("#f-to", (e) => e.dispatchEvent(new Event("change")));
  await page.waitForSelector("#f-from");
  await page.fill("#f-from", "16");
  await page.$eval("#f-from", (e) => e.dispatchEvent(new Event("change")));
  await page.waitForSelector(".slice-chip");
  assert.deepStrictEqual(await page.$$eval(".slice-chip", (c) => c.map((x) => x.dataset.slice)), ["16", "17", "18", "19", "20", "21"]);

  // Draw a polygon on slice 18 only.
  await page.click('.slice-chip[data-slice="18"]');
  await waitReadout(page, 18);
  await page.click('input[name="editScope"][value="slice"]');
  assert.strictEqual(await page.textContent("#stageBadge"), "Editing slice 18 only");
  await page.click('input[name="tolMode"][value="polygon"]');
  await page.click("#drawShapeBtn");
  await page.evaluate(() => window.scrollTo(0, 0));
  for (const [fx, fy] of [[0.3, 0.3], [0.7, 0.3], [0.5, 0.7]]) await stageClick(page, fx, fy);
  await page.click("#finishShapeBtn");
  await page.waitForSelector(".slice-chip.custom");
  assert.deepStrictEqual(await page.$$eval(".slice-chip.custom", (c) => c.map((x) => x.dataset.slice)), ["18"]);
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith("annotator:"))))[0]);
  let ann = await saved();
  assert.strictEqual(ann.overrides["18"].tolerance.mode, "polygon");
  assert.strictEqual(ann.tolerance.mode, "radius", "shared zone must stay a radius");

  // Copy 18's shape to 19.
  await page.click('.slice-chip[data-slice="19"]');
  await waitReadout(page, 19);
  await page.selectOption("#copyFromSel", "18");
  await page.click("#copyFromBtn");
  await page.waitForFunction(() => document.querySelectorAll(".slice-chip.custom").length === 2);
  ann = await saved();
  assert.strictEqual(ann.overrides["19"].tolerance.polygon.length, 3);

  // Make 19's shape the shared one; 18 keeps its own.
  await page.click("#useOnAllBtn");
  await page.waitForFunction(() => document.querySelectorAll(".slice-chip.custom").length === 1);
  ann = await saved();
  assert.strictEqual(ann.tolerance.mode, "polygon");
  assert.deepStrictEqual(Object.keys(ann.overrides), ["18"]);

  // Reset 18.
  await page.click('.slice-chip[data-slice="18"]');
  await waitReadout(page, 18);
  await page.click('input[name="editScope"][value="slice"]');
  await page.click("#resetOverrideBtn");
  await page.waitForFunction(() => document.querySelectorAll(".slice-chip.custom").length === 0);
});

test("per-slice polygons grade each slice against its own shape", async ({ page, site }) => {
  site.write("quiz/annotations.json", quizFile(site, [{
    id: "organ", type: "label", sliceFrom: 16, sliceTo: 18, x: 0.5, y: 0.5, text: "Organ",
    tolerance: { mode: "polygon", polygon: [{ x: 0.4, y: 0.4 }, { x: 0.6, y: 0.4 }, { x: 0.6, y: 0.6 }, { x: 0.4, y: 0.6 }] },
    overrides: { 18: { x: 0.2, y: 0.2, tolerance: { mode: "polygon", polygon: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.1 }, { x: 0.3, y: 0.3 }, { x: 0.1, y: 0.3 }] } } },
  }]));
  await page.goto(`${site.base}/quiz/index.html`);
  await page.waitForSelector("#startBtn");
  await page.click("#startBtn");
  await setSlider(page, 17);
  await waitReadout(page, 17);
  await stageClick(page, 0.5, 0.5);
  await page.click("#checkBtn");
  await page.waitForSelector(".outcome-banner.correct");
  await page.click("#nextBtn");
  await page.click('[data-retry="organ"]');
  await setSlider(page, 18);
  await waitReadout(page, 18);
  await stageClick(page, 0.5, 0.5); // shared square does not apply here
  await page.click("#checkBtn");
  await page.waitForSelector(".outcome-banner.incorrect");
  await stageClick(page, 0.2, 0.2);
  await page.click("#checkBtn");
  await page.waitForSelector(".outcome-banner.correct");
});

test("moving one end of the slice range past the other drags it along", async ({ page, site }) => {
  await page.goto(`${site.base}/annotator/index.html`);
  await page.waitForSelector("#svgHost svg");
  await setSlider(page, 10);
  await waitReadout(page, 10);
  await page.click('.palette-item[data-type="label"]');
  await stageClick(page, 0.5, 0.5);
  await page.waitForSelector("#f-from");
  await page.fill("#f-from", "15");
  await page.$eval("#f-from", (e) => e.dispatchEvent(new Event("change")));
  await page.waitForFunction(() => /#15$/.test(document.querySelector("#allAnnotationList .slice-tag").textContent));
});

// --- browser datasets and quiz packages ---------------------------------------------------

/** A small solid-colour PNG, so each fixture image has its own bytes. */
function makePng(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const png = (name, colour, size = 8) => ({ name, mimeType: "image/png", buffer: makePng(size, size, colour) });
const BRAIN = () => [png("brain-10.png", [200, 0, 0]), png("brain-01.png", [0, 200, 0]), png("brain-2.png", [0, 0, 200])];

/** Read a zip written with the store method: { name: Buffer }. */
function readZip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  assert.ok(eocd >= 0, "not a zip");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.strictEqual(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    assert.strictEqual(method, 0, `${name} should be stored, not compressed`);
    out[name] = buf.subarray(start, start + size);
    assert.strictEqual(zlib.crc32 ? zlib.crc32(out[name]) : crc, crc, `${name} has a wrong CRC`);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** The fingerprint scripts/lib_manifest.py computes for a set of files. */
function pythonFingerprint(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-fp-"));
  try {
    files.forEach((f) => fs.writeFileSync(path.join(dir, f.name), f.buffer));
    const code = "import sys, json; sys.path.insert(0, sys.argv[1]); import lib_manifest; m = lib_manifest.build_manifest(sys.argv[2]); print(json.dumps(m))";
    return JSON.parse(execFileSync("python3", ["-c", code, path.join(ROOT, "scripts"), dir], { encoding: "utf8" }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Rewrite a zip with Python: optionally deflate it, and/or replace entries. */
function rewriteZip(src, dest, { deflate = false, replace = {}, drop = [] } = {}) {
  const code = `
import sys, json, zipfile, base64
src, dest, deflate, replace, drop = sys.argv[1], sys.argv[2], sys.argv[3] == "1", json.loads(sys.argv[4]), json.loads(sys.argv[5])
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED if deflate else zipfile.ZIP_STORED) as zout:
    for name in zin.namelist():
        if name in drop: continue
        zout.writestr(name, base64.b64decode(replace[name]) if name in replace else zin.read(name))
`;
  const encoded = Object.fromEntries(Object.entries(replace).map(([k, v]) => [k, Buffer.from(v).toString("base64")]));
  execFileSync("python3", ["-c", code, src, dest, deflate ? "1" : "0", JSON.stringify(encoded), JSON.stringify(drop)]);
}

async function importStack(page, site, files, name) {
  await page.goto(`${site.base}/index.html`);
  await page.waitForSelector("#datasetList li");
  await page.setInputFiles("#pickFiles", files);
  await page.waitForSelector("#pending:not([hidden])");
  if (name) await page.fill("#datasetName", name);
  await page.click("#saveDatasetBtn");
  await page.waitForSelector("#pending", { state: "hidden" });
  await page.waitForSelector("#datasetList li.current .ds-actions");
}

async function addLabel(page, text, fx = 0.5, fy = 0.5) {
  await page.click('.palette-item[data-type="label"]');
  await stageClick(page, fx, fy);
  await page.waitForSelector("#f-text");
  await page.fill("#f-text", text);
}

/** Export a quiz package from the annotator and return { name, file, entries }. */
async function exportPackage(page, { confirmEmpty = false } = {}) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    (async () => {
      await page.click("#exportBtn");
      await page.click("#exportDownloadBtn");
      if (confirmEmpty) await page.click("#confirmOkBtn");
    })(),
  ]);
  const file = await download.path();
  return { name: download.suggestedFilename(), file, entries: readZip(fs.readFileSync(file)) };
}

test("start page: chosen images are ordered, hashed like the Python script, and become the active stack", async ({ page, site }) => {
  await page.goto(`${site.base}/index.html`);
  await page.waitForSelector("#datasetList li");
  assert.match(await page.textContent("#datasetList"), /served from data\/slices\//);
  await page.setInputFiles("#pickFiles", [...BRAIN(), { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("x") }]);
  await page.waitForSelector("#pending:not([hidden])");
  assert.deepStrictEqual(await page.$$eval("#thumbStrip .thumb-name", (els) => els.map((e) => e.textContent)), ["brain-01.png", "brain-2.png", "brain-10.png"]);
  assert.deepStrictEqual(await page.$$eval("#thumbStrip .thumb-num", (els) => els.map((e) => e.textContent)), ["1", "2", "3"]);
  assert.match(await page.textContent("#pendingSummary"), /^3 slices · /);
  assert.match(await page.textContent("#importReport"), /1 file skipped \(not an image\): notes\.txt/);
  assert.strictEqual(await page.inputValue("#datasetName"), "brain");

  await page.fill("#datasetName", "Brain MRI week 3");
  await page.click("#saveDatasetBtn");
  await page.waitForSelector("#datasetList li.current .ds-actions");
  assert.match(await page.textContent("#datasetList li.current"), /Brain MRI week 3.*3 slices/s);
  assert.match(await page.textContent("#activeLine"), /Brain MRI week 3/);
  assert.match(await page.textContent("#storageInfo"), /1 stack stored here/);

  const stored = await page.evaluate(() => Scanner.listDatasets());
  const expected = pythonFingerprint(BRAIN());
  assert.deepStrictEqual(stored[0].files, expected.files);
  assert.deepStrictEqual(stored[0].fileHashes, expected.fileHashes);
  assert.strictEqual(stored[0].id, expected.datasetHash, "browser and Python fingerprints differ");
  assert.strictEqual(stored[0].size, 8);

  await page.click("#annotateLink");
  await page.waitForSelector("#svgHost img");
  assert.match(await page.getAttribute("#svgHost img", "src"), /^blob:/);
  assert.strictEqual(await page.textContent("#readout"), "1 / 3");
  assert.strictEqual(await page.$eval("#datasetSwitch", (s) => s.selectedOptions[0].textContent), "Brain MRI week 3 · 3 slices");
  assert.match(await page.textContent("#datasetInfo"), /Brain MRI week 3 · 3 slices/);
});

test("start page: SVGs are cleaned at import, broken ones skipped, mixed sizes warned", async ({ page, site }) => {
  await page.goto(`${site.base}/index.html`);
  await page.waitForSelector("#datasetList li");
  await page.setInputFiles("#pickFiles", [
    { name: "s1.svg", mimeType: "image/svg+xml", buffer: Buffer.from(SCRIPTED_SVG) },
    { name: "s2.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<html>not svg</html>") },
    png("s3.png", [9, 9, 9]),
  ]);
  await page.waitForSelector("#pending:not([hidden])");
  const report = await page.textContent("#importReport");
  assert.match(report, /1 file skipped \(not a valid SVG image\): s2\.svg/);
  assert.match(report, /not all the same size/);
  await page.click("#saveDatasetBtn");
  await page.waitForSelector("#datasetList li.current .ds-actions");
  const stored = await page.evaluate(async () => {
    const [d] = await Scanner.listDatasets();
    const blob = await Scanner.readSliceBlob(d.id, "s1.svg");
    const text = await blob.text();
    return { files: d.files, text, hash: d.fileHashes["s1.svg"], rehash: await Scanner.hashBytes(await blob.arrayBuffer()), size: d.size };
  });
  assert.deepStrictEqual(stored.files, ["s1.svg", "s3.png"]);
  assert.ok(!/script|onclick|onerror|foreignObject|javascript:/i.test(stored.text), `unsafe markup was stored: ${stored.text}`);
  assert.ok(/data-layer="skin"/.test(stored.text), "safe content was lost");
  assert.strictEqual(stored.hash, stored.rehash, "hash is not of the stored bytes");
  assert.strictEqual(stored.size, 400);
  assert.strictEqual(await page.evaluate(() => window.__svgScript || window.__svgHandler || window.__svgForeign), undefined);
});

test("start page: a folder pick ignores sub-folders; dropped files work; the same images twice are one stack", async ({ page, site }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-pick-"));
  const series = path.join(dir, "knee series");
  fs.mkdirSync(path.join(series, "old"), { recursive: true });
  BRAIN().forEach((f) => fs.writeFileSync(path.join(series, f.name), f.buffer));
  fs.writeFileSync(path.join(series, "old", "extra.png"), makePng(8, 8, [1, 2, 3]));
  try {
    await page.goto(`${site.base}/index.html`);
    await page.waitForSelector("#datasetList li");
    await page.setInputFiles("#pickFolder", series);
    await page.waitForSelector("#pending:not([hidden])");
    assert.match(await page.textContent("#pendingSummary"), /^3 slices/);
    assert.match(await page.textContent("#importReport"), /1 file in sub-folders was ignored/);
    assert.strictEqual(await page.inputValue("#datasetName"), "knee series");
    await page.click("#saveDatasetBtn");
    await page.waitForSelector("#datasetList li.current .ds-actions");

    // Dropping the same three files: recognised, not duplicated.
    await page.evaluate((files) => {
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: "image/png" })));
      document.getElementById("dropZone").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, BRAIN().map((f) => ({ name: f.name, b64: f.buffer.toString("base64") })));
    await page.waitForSelector('.notice[data-notice-id="import"]');
    assert.match(await page.textContent('.notice[data-notice-id="import"]'), /already stored as “knee series”/);
    assert.strictEqual(await page.isHidden("#pending"), true);
    assert.strictEqual((await page.evaluate(() => Scanner.listDatasets())).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cached stack: work survives a reload, the switcher changes stack, delete keeps annotations, rename shows everywhere", async ({ page, site }) => {
  await importStack(page, site, BRAIN(), "Brain A");
  await page.goto(`${site.base}/annotator/index.html`);
  await page.waitForSelector("#svgHost img");
  await addLabel(page, "Thalamus");
  await page.reload();
  await page.waitForSelector(".marker");
  assert.match(await page.textContent("#annotationList"), /Thalamus/);

  // Switch to the folder stack: its own (empty) annotations, fetched by URL.
  await Promise.all([page.waitForNavigation(), page.selectOption("#datasetSwitch", "folder")]);
  await page.waitForSelector("#svgHost svg");
  assert.strictEqual(await page.textContent("#readout"), "1 / 40");
  assert.strictEqual(await page.$$eval(".marker", (m) => m.length), 0);
  assert.strictEqual(await page.$eval("#datasetSwitch", (s) => s.selectedOptions[0].textContent), "Sample stack (folder) · 40 slices");

  await page.goto(`${site.base}/index.html`);
  await page.waitForSelector("#datasetList li .ds-actions");
  assert.match(await page.textContent("#datasetList li:first-child"), /1 annotation/);
  await page.click("[data-rename]");
  await page.fill("#promptInput", "Brain renamed");
  await page.click("#promptOkBtn");
  await page.waitForFunction(() => document.querySelector("#datasetList .ds-name").textContent === "Brain renamed");

  await page.click("[data-delete]");
  assert.match(await page.textContent(".modal"), /1 annotation stay autosaved/);
  await page.click("#confirmOkBtn");
  await page.waitForFunction(() => !document.querySelector("#datasetList .ds-actions"));
  assert.strictEqual(await page.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open("scanner"); r.onsuccess = () => res(r.result); });
    return new Promise((res) => { const r = db.transaction("slices").objectStore("slices").count(); r.onsuccess = () => res(r.result); });
  }), 0, "slice bytes were left behind");

  // The same images again: the annotations are still there.
  await importStack(page, site, BRAIN(), "Brain again");
  await page.click("#annotateLink");
  await page.waitForSelector(".marker");
  assert.match(await page.textContent("#annotationList"), /Thalamus/);
  assert.match(await page.$eval("#datasetSwitch", (s) => s.selectedOptions[0].textContent), /^Brain again/);
});

test("quiz package: export holds images, manifest and annotations; Python installs it with the same fingerprint", async ({ page, site }) => {
  await importStack(page, site, BRAIN(), "Brain MRI week 3");
  await page.goto(`${site.base}/annotator/index.html`);
  await page.waitForSelector("#svgHost img");
  await addLabel(page, "Thalamus");
  const pkg = await exportPackage(page);
  assert.match(pkg.name, /^brain-mri-week-3-quiz-\d{4}-\d{2}-\d{2}\.zip$/);
  assert.deepStrictEqual(Object.keys(pkg.entries).sort(), ["README.txt", "annotations.json", "manifest.json", "slices/brain-01.png", "slices/brain-10.png", "slices/brain-2.png"]);
  const manifest = JSON.parse(pkg.entries["manifest.json"].toString());
  const expected = pythonFingerprint(BRAIN());
  assert.strictEqual(manifest.name, "Brain MRI week 3");
  assert.deepStrictEqual(manifest.files, expected.files);
  assert.strictEqual(manifest.datasetHash, expected.datasetHash);
  assert.strictEqual(manifest.sliceCount, 3);
  BRAIN().forEach((f) => {
    assert.ok(pkg.entries[`slices/${f.name}`].equals(f.buffer), `${f.name} bytes changed`);
    assert.strictEqual(manifest.fileHashes[f.name], sha256(f.buffer));
  });
  const annotations = JSON.parse(pkg.entries["annotations.json"].toString());
  assert.strictEqual(annotations.datasetHash, manifest.datasetHash);
  assert.strictEqual(annotations.exportMode, "quiz");
  assert.strictEqual(annotations.annotations[0].text, "Thalamus");
  assert.match(pkg.entries["README.txt"].toString(), /install_package\.py/);

  // The annotations-only export of the same work is the same payload.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    (async () => {
      await page.click("#exportBtn");
      await page.check('input[name="exportWhat"][value="json"]');
      await page.click("#exportDownloadBtn");
    })(),
  ]);
  assert.strictEqual(fs.readFileSync(await download.path(), "utf8"), pkg.entries["annotations.json"].toString());

  // Install into the hosted folder: refused without --force, then fingerprint parity.
  const script = path.join(site.dir, "scripts", "install_package.py");
  let refused = "";
  try {
    execFileSync("python3", [script, pkg.file], { encoding: "utf8", stdio: "pipe" });
  } catch (err) {
    refused = err.stderr;
  }
  assert.match(refused, /would replace the 40 image\(s\).*--force/s);
  assert.strictEqual(site.json("data/slices/manifest.json").sliceCount, 40, "refused install still changed the folder");
  const out = execFileSync("python3", [script, pkg.file, "--force"], { encoding: "utf8" });
  assert.match(out, /3 slice\(s\)/);
  const installed = site.json("data/slices/manifest.json");
  assert.strictEqual(installed.datasetHash, manifest.datasetHash);
  assert.strictEqual(installed.name, "Brain MRI week 3");
  assert.strictEqual(site.read("quiz/annotations.json"), pkg.entries["annotations.json"].toString());

  // A student's browser (nothing cached) gets the hosted quiz with no warning.
  await page.evaluate(() => Scanner.setActiveId(null));
  await page.goto(`${site.base}/quiz/index.html`);
  await page.waitForSelector("#startBtn");
  assert.match(await page.textContent("#datasetInfo"), /1 item/);
  assert.strictEqual(await page.$$eval(".notice.warn, .notice.error", (n) => n.length), 0);
  assert.match(await page.getAttribute("#svgHost img", "src"), /data\/slices\/brain-01\.png$/);
});

test("quiz package: the folder stack can be packaged too, and an empty quiz is confirmed first", async ({ page, site }) => {
  await page.goto(`${site.base}/annotator/index.html`);
  await page.waitForSelector("#svgHost svg");
  await page.click("#exportBtn");
  await page.click("#exportDownloadBtn");
  await page.waitForSelector("#confirmOkBtn");
  assert.match(await page.textContent("#confirmTitle"), /no questions/);
  await page.click("#confirmCancelBtn");
  await page.click("#exportCancelBtn");
  const pkg = await exportPackage(page, { confirmEmpty: true });
  const manifest = JSON.parse(pkg.entries["manifest.json"].toString());
  const folder = site.json("data/slices/manifest.json");
  assert.strictEqual(manifest.datasetHash, folder.datasetHash);
  assert.strictEqual(Object.keys(pkg.entries).filter((n) => n.startsWith("slices/")).length, 40);
  assert.ok(pkg.entries["slices/slice-007.svg"].equals(fs.readFileSync(path.join(site.dir, "data/slices/slice-007.svg"))));
  assert.deepStrictEqual(JSON.parse(pkg.entries["annotations.json"].toString()).annotations, []);
});

/** Build a package in one browser context and hand back its path. */
async function makePackage(page, site, labels = ["Thalamus"]) {
  await importStack(page, site, BRAIN(), "Brain MRI week 3");
  await page.goto(`${site.base}/annotator/index.html`);
  await page.waitForSelector("#svgHost img");
  for (let i = 0; i < labels.length; i++) await addLabel(page, labels[i], 0.3 + i * 0.3, 0.5);
  return exportPackage(page);
}

async function freshPage(page) {
  const context = await page.context().browser().newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  context.setDefaultTimeout(10000);
  const p = await context.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  return { page: p, errors, close: () => context.close() };
}

test("quiz: a student imports a package, the stack is cached, and progress survives a reload", async ({ page, site }) => {
  const pkg = await makePackage(page, site);
  const student = await freshPage(page);
  try {
    const p = student.page;
    await p.goto(`${site.base}/quiz/index.html`);
    await p.waitForSelector("#startBtn");
    assert.strictEqual(await p.textContent("#readout"), "1 / 40");
    await Promise.all([p.waitForNavigation(), p.setInputFiles("#importFile", pkg.file)]);
    await p.waitForSelector("#startBtn");
    assert.strictEqual(await p.textContent("#readout"), "1 / 3");
    assert.match(await p.getAttribute("#svgHost img", "src"), /^blob:/);
    assert.match(await p.$eval("#datasetSwitch", (s) => s.selectedOptions[0].textContent), /^Brain MRI week 3 · 3 slices/);
    assert.strictEqual(await p.$$eval(".notice.warn, .notice.error", (n) => n.length), 0);

    await p.click("#startBtn");
    await waitStep(p, "1 of 1");
    await stageClick(p, 0.3, 0.5);
    await p.click("#checkBtn");
    await p.waitForSelector(".outcome-banner.correct");
    await p.reload();
    await p.waitForSelector("#targetsList li");
    assert.strictEqual(await p.textContent("#progressCount"), "1 / 1");
    assert.strictEqual(await p.textContent("#readout"), "1 / 3");

    // A plain annotations.json still imports against the current stack.
    // (Same file, so the saved progress applies to it as well.)
    await p.setInputFiles("#importFile", { name: "annotations.json", mimeType: "application/json", buffer: pkg.entries["annotations.json"] });
    await p.waitForSelector("#targetsList li");
    assert.strictEqual(await p.textContent("#progressCount"), "1 / 1");
    assert.strictEqual(await p.$$eval(".notice.warn, .notice.error", (n) => n.length), 0);
    assert.deepStrictEqual(student.errors, []);
  } finally {
    await student.close();
  }
});

test("quiz: altered, damaged and compressed packages are handled", async ({ page, site }) => {
  const pkg = await makePackage(page, site);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-zips-"));
  const student = await freshPage(page);
  try {
    const p = student.page;
    await p.goto(`${site.base}/quiz/index.html`);
    await p.waitForSelector("#startBtn");

    // Not a zip at all, and a zip that isn't a package: message, nothing changes.
    await p.setInputFiles("#importFile", { name: "broken.zip", mimeType: "application/zip", buffer: Buffer.from("this is not a zip file at all, really") });
    await p.waitForSelector(".notice.error");
    assert.match(await p.textContent(".notice.error"), /not a zip package/);
    const noManifest = path.join(dir, "nomanifest.zip");
    rewriteZip(pkg.file, noManifest, { drop: ["manifest.json"] });
    await p.setInputFiles("#importFile", noManifest);
    await p.waitForFunction(() => /no manifest\.json/.test((document.querySelector(".notice.error") || {}).textContent || ""));
    assert.strictEqual(await p.textContent("#readout"), "1 / 40");

    // One slice swapped after export: named, and cancel leaves things alone.
    const altered = path.join(dir, "altered.zip");
    rewriteZip(pkg.file, altered, { replace: { "slices/brain-2.png": makePng(8, 8, [7, 7, 7]) } });
    await p.setInputFiles("#importFile", altered);
    await p.waitForSelector("#confirmOkBtn");
    assert.match(await p.textContent(".modal"), /1 of 3 images differ.*brain-2\.png/s);
    await p.click("#confirmCancelBtn");
    assert.strictEqual(await p.textContent("#readout"), "1 / 40");
    assert.strictEqual((await p.evaluate(() => Scanner.listDatasets())).length, 0);

    // Deflated by another tool: still readable.
    const deflated = path.join(dir, "deflated.zip");
    rewriteZip(pkg.file, deflated, { deflate: true });
    await Promise.all([p.waitForNavigation(), p.setInputFiles("#importFile", deflated)]);
    await p.waitForSelector("#startBtn");
    assert.strictEqual(await p.textContent("#readout"), "1 / 3");
    assert.deepStrictEqual(student.errors, []);
  } finally {
    await student.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("quiz: with browser storage blocked a package opens for the visit, with a heads-up", async ({ page, site }) => {
  const pkg = await makePackage(page, site);
  const student = await freshPage(page);
  try {
    const p = student.page;
    await p.addInitScript(() => { Object.defineProperty(window, "indexedDB", { get: () => undefined }); });
    await p.goto(`${site.base}/quiz/index.html`);
    await p.waitForSelector("#startBtn");
    await p.setInputFiles("#importFile", pkg.file);
    await p.waitForFunction(() => document.getElementById("readout").textContent === "1 / 3");
    await p.waitForSelector("#startBtn");
    assert.match(await p.textContent('.notice[data-notice-id="storage"]'), /this visit only/);
    assert.match(await p.$eval("#datasetSwitch", (s) => s.selectedOptions[0].textContent), /not saved/);
    await p.click("#startBtn");
    await waitStep(p, "1 of 1");
    await stageClick(p, 0.3, 0.5);
    await p.click("#checkBtn");
    await p.waitForSelector(".outcome-banner.correct");

    await p.goto(`${site.base}/index.html`);
    await p.waitForSelector('.notice[data-notice-id="storage"]');
    assert.match(await p.textContent('.notice[data-notice-id="storage"]'), /can't be kept in this browser/);
    await p.setInputFiles("#pickFiles", BRAIN());
    await p.waitForSelector("#pending:not([hidden])");
    await p.click("#saveDatasetBtn");
    await p.waitForSelector('.notice.error[data-notice-id="import"]');
    assert.match(await p.textContent('.notice.error[data-notice-id="import"]'), /could not be saved.*build_manifest\.py/s);
    assert.deepStrictEqual(student.errors, []);
  } finally {
    await student.close();
  }
});

test("annotator: a package restores a session elsewhere, and existing autosave is offered first", async ({ page, site }) => {
  const pkg = await makePackage(page, site, ["Thalamus", "Pons"]);
  const other = await freshPage(page);
  try {
    const p = other.page;
    await p.goto(`${site.base}/annotator/index.html`);
    await p.waitForSelector("#svgHost svg");
    await Promise.all([p.waitForNavigation(), p.setInputFiles("#importFile", pkg.file)]);
    await p.waitForSelector(".marker");
    assert.strictEqual(await p.textContent("#readout"), "1 / 3");
    assert.strictEqual(await p.textContent("#totalAnnCount"), "2");
    assert.match(await p.$eval("#datasetSwitch", (s) => s.selectedOptions[0].textContent), /^Brain MRI week 3/);

    // Remove one, then import the package again: asked which to keep.
    await p.click(".marker");
    await p.click("#deleteBtn");
    await p.waitForFunction(() => document.getElementById("totalAnnCount").textContent === "1");
    await p.setInputFiles("#importFile", pkg.file);
    await p.waitForSelector("#confirmOkBtn");
    assert.match(await p.textContent(".modal"), /1 annotation is autosaved here.*package holds 2/s);
    await Promise.all([p.waitForNavigation(), p.click("#confirmCancelBtn")]);
    await p.waitForSelector(".marker");
    assert.strictEqual(await p.textContent("#totalAnnCount"), "1");

    // The quiz previews the annotator's current work on that stack.
    await p.goto(`${site.base}/quiz/index.html`);
    await p.waitForSelector("#startBtn");
    assert.match(await p.textContent('.notice[data-notice-id="preview"]'), /Previewing the annotator's current work/);
    assert.match(await p.textContent("#datasetInfo"), /1 item/);

    // From the start page the same file opens too.
    await p.goto(`${site.base}/index.html`);
    await p.waitForSelector("#datasetList li.current");
    await p.setInputFiles("#pickPackage", pkg.file);
    await p.waitForSelector("#confirmOkBtn");
    await p.click("#confirmOkBtn");
    await p.waitForFunction(() => /2 annotations/.test(document.querySelector("#datasetList li.current").textContent));
    assert.deepStrictEqual(other.errors, []);
  } finally {
    await other.close();
  }
});

// --- run -------------------------------------------------------------------------------------

(async () => {
  const grep = process.argv.includes("--grep") ? process.argv[process.argv.indexOf("--grep") + 1] : null;
  const browser = await chromium.launch();
  let failed = 0;
  for (const t of tests) {
    if (grep && !t.name.includes(grep)) continue;
    const site = await makeSite();
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
    context.setDefaultTimeout(10000); // so a stuck step names its selector
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    const started = Date.now();
    try {
      await Promise.race([
        t.fn({ page, site }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out after 30s")), 30000)),
      ]);
      if (pageErrors.length) throw new Error(`page errors: ${pageErrors.join(" | ")}`);
      console.log(`  ok   ${t.name} (${Date.now() - started} ms)`);
    } catch (err) {
      failed += 1;
      console.log(`  FAIL ${t.name}\n       ${err.message.split("\n").join("\n       ")}`);
    } finally {
      await context.close();
      await site.close();
    }
  }
  await browser.close();
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
