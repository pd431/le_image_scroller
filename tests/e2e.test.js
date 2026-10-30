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

// --- run -------------------------------------------------------------------------------------

(async () => {
  const grep = process.argv.includes("--grep") ? process.argv[process.argv.indexOf("--grep") + 1] : null;
  const browser = await chromium.launch();
  let failed = 0;
  for (const t of tests) {
    if (grep && !t.name.includes(grep)) continue;
    const site = await makeSite();
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
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
