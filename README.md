# Radiology Scanner (Moodle-friendly annotation + quiz tools)

A very lightweight pair of static, client-only tools (pure HTML/CSS/JS,
no server-side storage) built around a stack of sliced scan images:

1. **Annotator** (educator) — mark up features on a slice stack and
   export the annotations as a file.
2. **Quiz** (student) — load a slice stack + exported annotation file,
   and practice placing the known features on the correct slice.

Everything the site needs is just files in this folder — it can be
hosted as-is (e.g. as a Moodle-embeddable static page). It is meant for
self-testing and sharing information with students, not for summative
assessment: the quiz's answers live in a plain file the browser
downloads, so anyone can read them.

See **[guide.html](guide.html)** for a short, task-oriented walkthrough
of both tools — this README is the fuller technical reference.

## Quick start: images to quiz, in the browser

```
python3 scripts/serve.py
```

This serves the folder and opens the start page (`index.html`). From
there:

1. **Choose your images** — pick the files of one series, choose a
   folder, or drop them on the page. They are put in filename order
   (numbers counted as numbers), hashed, and shown as a numbered strip
   so you can check the order. Name the stack and save it. The images
   stay in this browser; nothing is uploaded.
2. **Pick the stack to work on** — every stack stored in this browser
   is listed, along with the folder stack in `data/slices/`.
3. **Annotate**, try the quiz, then **Export…** a *quiz package*: one
   zip with the images, the manifest and the annotations.

Students open the package with **Import…** in the quiz. To host it
instead (e.g. on Moodle), run `python3 scripts/install_package.py
<package>.zip` and upload the folder; the quiz then loads with no
import step.

Stacks live in the browser's storage (IndexedDB), which a browser can
clear — Safari does after a week without a visit. The exported package
is the copy that lasts.

Layout:

```
index.html   start page: choose images, pick a stack (start.js, start.css)
annotator/   educator tool (index.html, app.js, style.css)
quiz/        student tool (index.html, app.js, style.css, annotations.json)
shared/      common.js (runtime shared by all pages), datasets.js (browser
             stacks, zip packages) and theme.css (colour tokens + layout)
data/slices/ the folder image stack and its manifest.json
scripts/     serve.py, install_package.py, build_manifest.py,
             generate_slices.py, check_contrast.py
tests/       Playwright end-to-end tests and Python unit tests
```

## Serving and hosting

The pages fetch their data, so they must be served over HTTP (opening
`index.html` from the file system shows an explanation instead):

```
python3 scripts/serve.py         # opens http://localhost:8000/ in the browser
```

`serve.py` is a read-only static server (GET and HEAD only) that picks
the next free port if 8000 is taken; `--no-browser`, `--port` and
`--host 0.0.0.0` are available. Any other static server works too, e.g.
`python3 -m http.server 8000`.

For Moodle, upload the whole folder as-is (a File resource or a folder
on the web server) and link to `quiz/index.html`. Notes:

- Serve over **https** where you can. Browsers block storage inside a
  cross-site frame in some configurations; when that happens the apps
  show a banner saying autosave / progress saving is off, and exporting
  is the only way to keep work.
- Each page carries a `Content-Security-Policy` meta tag that allows
  only the folder's own scripts to run, as a backstop behind the input
  handling described under *Security* below.
- Grades do not reach the Moodle gradebook; the score is on-screen only.

## Dataset

`data/slices/` contains a placeholder "apple cross-section" slice
stack: each slice is a horizontal cut through an apple, scanned bottom
to top. The outer silhouette starts small at the base, grows to its
widest at the equator, then narrows toward the stem; a star-shaped
core with 5 seed pockets fades in and out around the middle; a calyx
dimple shows at the very bottom slices and a stem nub at the very top
ones. A shape that visibly grows/shrinks with height reads much more
naturally as "moving through a volume" than an abstract rotating
polygon did — it's a stand-in for real cross-sectional anatomy, good
enough to build and test the annotation/quiz tools against.

Layers per slice (see `data-layer` attribute in each SVG, and
`manifest.json`): `skin`, `flesh`, `core`, `seed`, `stem`, `calyx` —
the last two only appear near the top/bottom of the stack.

Regenerate it with:

```
python3 scripts/generate_slices.py
```

This writes `data/slices/slice-001.svg` … `slice-040.svg` and a
`data/slices/manifest.json` describing the stack (slice count, layer
ids/labels, file list).

Open `preview.html` (served over HTTP, e.g. `python3 -m http.server`)
to scrub through the generated stack.

### Using your own images instead

There are two routes, and they give the same result for the same files.

**In the browser** (the start page, see *Quick start*): choose the
files and the page builds the stack for you. Stacks are stored per
browser in IndexedDB, keyed by fingerprint; the tools use the one
marked as in use and fall back to the folder stack when there is none.
The header of each tool has a switcher for it. SVGs are passed through
the sanitiser at import and the cleaned file is what is stored, hashed
and exported. Deleting a stack removes its images but keeps its
autosaved annotations, which come back if the same images are chosen
again. If the browser blocks storage (private windows, some embedded
frames) the start page says so and the folder route still works.

**In the folder**: the slice list comes from `data/slices/manifest.json`, but you
don't need to hand-edit it — `manifest.json`'s `files` list is just a
scan of the folder, sorted naturally by filename (case-insensitive,
and numbers inside the name sort numerically — `abc2.jpg` before
`abc10.jpg` whether or not you zero-pad). Drop in your own `.svg`,
`.png`, `.jpg`/`.jpeg`, `.gif` or `.webp` images (filenames can have
spaces), then run:

```
python3 scripts/build_manifest.py
```

to rebuild the index from whatever's actually in the folder — it
leaves the images themselves untouched and only refreshes the file
list, so it's safe to run alongside (or instead of) the apple
generator above.

The script also writes a SHA-256 per file (`fileHashes`) and a
`datasetHash` fingerprint of the whole ordered stack. Exports carry the
fingerprint, and both tools compare it against the manifest when a file
is loaded: the annotator asks before importing a file made for a
different stack, and the quiz shows a warning but still loads. Adding,
removing, renaming or re-ordering a slice changes the numbering every
annotation depends on, so re-export after any change to the images.
Slices shown as **SVG** go through a sanitiser (see *Security*); raster
images are shown as plain pictures.

Non-SVG images are shown as plain pictures — layer auto-detection in
the annotator (which relies on `data-layer` attributes on SVG shapes)
just won't find a layer for them, which is already handled gracefully
(the annotation is simply left unassigned). For annotation coordinates
to line up consistently across the whole stack, images should ideally
share the same dimensions/aspect ratio, matching how real scan slices
from one series are usually exported.

## Annotator (`annotator/`)

The educator-facing tool. Works on desktop, iPad and phones — the
layout collapses to a single column below ~1100px, and touch targets
grow on touchscreens. Scrub through the slice stack and add one of
three annotation types from the palette onto the slice: drag-and-drop
with a mouse, or on touch, tap a type (it "arms") then tap the slice
to place it.

- **Text label** — a short string shown right on the image.
- **Pin + description** — a marker with a longer write-up (visible on
  hover as a tooltip, and in full when the pin is opened).
- **MCQ** — a marker with a question and a dropdown of options (default
  "Rot / Bite mark / Healthy apple", both editable), with one option
  marked as the correct answer.

Wherever an annotation is dropped, its `layer` is auto-detected from
the `data-layer` attribute of the SVG shape under the cursor (skin,
flesh, core, seed, stem, calyx) — no manual tagging needed. Clicking an
existing marker (or a list entry) opens it in the **inspector** panel
on the right, where every field is live-bound — no separate save step.
Markers can be dragged to reposition (a plain click opens the
inspector instead; dragging re-detects the layer on release).

Every annotation also carries an **acceptable zone** — the tolerance
the quiz tool will use to judge a student's placement as correct. The
inspector's "Acceptable zone" section offers two modes:

- **Radius** (default, quick) — a slider sets a tolerance circle
  centred on the pin, shown live on the slice.
- **Custom shape** — click "Draw shape" and click points directly on
  the slice to trace an arbitrary polygon (doesn't need to be centred
  on, or even touch, the pin); "Finish shape" needs at least 3 points,
  "Undo point"/"Cancel" are also available.

The **All annotations** panel (left sidebar, expandable) lists every
annotation across the whole stack, sortable by slice order, type, or
title (A–Z / Z–A); clicking an entry jumps straight to its slice and
opens it in the inspector.

An annotation can **span several slices**: the inspector's "Slices"
section takes a from/to range and the annotation then appears on every
slice in it with one shared zone. Because an organ can look different
on each slice, any slice can have **its own zone of a different size
or shape**. The "Zone per slice" section shows a strip with one chip
per slice in range (a dot marks slices with their own zone; click a
chip to go there), and an "Edit the zone on" choice: *All slices* edits
the shared zone, *Slice N only* gives the current slice its own copy
and makes the position, radius and shape controls (and marker
dragging) act on that copy; a badge on the image says which you are
editing. From there, *Copy from* seeds the current slice's zone from
the shared zone or another custom slice, *Use on all slices* promotes
the current slice's zone to the shared one, and *Reset to shared*
drops it. A dashed ring marks a marker whose slice has its own zone.
"This slice only" collapses the range back to one slice, keeping the
zone in effect on the slice you're looking at.

Annotations autosave to the browser's local storage as you work, in a
slot keyed by the image stack's fingerprint, so two copies of the tool
on one host with different stacks don't overwrite each other. If
storage is blocked or full, a banner says so (the work stays in memory
until you export). Work saved by the pre-fingerprint version is offered
for recovery once.

**Export…** asks what to download and what the export is for:

- **Quiz package (.zip)** — `manifest.json`, `slices/<every image>`,
  `annotations.json` and a `README.txt`, in one file. It works from a
  browser stack or the folder stack, is fingerprinted from the bytes
  being packaged, and is stored without compression (the images already
  are), written by a small zip writer in `shared/datasets.js`.
- **Annotations only (.json)** — the single `annotations.json` (schema
  below), for a stack whose images are already hosted next to the quiz.

**Import…** takes either. An annotations file is loaded into the
current stack, validating every entry (bad ones are skipped and
reported) and converting older exports. A package is stored as a
browser stack and becomes the one in use, with its annotations; if this
browser already holds autosaved work for those exact images you are
asked which to keep. Each image in a package is checked against the
manifest's hashes, and you are told which differ before anything is
stored.

- **Quiz vs. showcase** — Quiz: students place the features themselves
  and get checked. Showcase: a read-only walkthrough of the annotated
  slices (no placing, everything is already shown).
- **Quiz mode** (quiz exports only) — **Full challenge**: students
  must find both the right slice and the right spot; slice hints appear
  only after a miss. **Guided**: the slice range for the current item
  is highlighted under the slider from the start, so only the spot is
  tested.

```jsonc
{
  "version": 3,
  "exportMode": "quiz", // or "showcase"
  "quizMode": "guided", // "full" | "guided" - only present when exportMode is "quiz"
  "datasetHash": "f54b…", // from data/slices/manifest.json; null if the stack has none
  "dataset": { "size": 400, "sliceCount": 40, "axis": "height, bottom to top" },
  "annotations": [
    { "id": "…", "type": "label", "sliceFrom": 18, "sliceTo": 18, "layer": "core", "x": 0.5, "y": 0.5, "text": "Core",
      "tolerance": { "mode": "radius", "radius": 0.06 } },
    { "id": "…", "type": "pin", "sliceFrom": 16, "sliceTo": 21, "layer": "flesh", "x": 0.28, "y": 0.5,
      "title": "Flesh", "description": "…",
      "tolerance": { "mode": "radius", "radius": 0.2 },
      "overrides": { "19": { "x": 0.3, "y": 0.52, "tolerance": { "mode": "radius", "radius": 0.15 } } } },
    { "id": "…", "type": "mcq", "sliceFrom": 22, "sliceTo": 22, "layer": "flesh", "x": 0.5, "y": 0.38,
      "question": "What condition does this point to?",
      "options": ["Rot", "Bite mark", "Healthy apple"], "answer": "Healthy apple",
      "tolerance": { "mode": "polygon", "polygon": [{ "x": 0.42, "y": 0.35 }, { "x": 0.58, "y": 0.35 }, { "x": 0.58, "y": 0.55 }, { "x": 0.42, "y": 0.55 }] } }
  ]
}
```

An annotation applies to every slice from `sliceFrom` to `sliceTo`
inclusive. `x`/`y`/`tolerance` are its default zone; `overrides` maps a
slice index to a zone that replaces the default on that slice only.
Version 2 files (single `sliceIndex`) are accepted by both tools and
upgraded on import.

`x`/`y` (and polygon point coordinates) are fractions (0–1) of the
slice image, so positions stay correct regardless of display size.
`tolerance.radius` is also a fraction of the image width.

## Quiz (`quiz/`)

The student-facing tool. Loads `quiz/annotations.json` (a static file
next to the page — replace it with your own export from the
annotator) by default, or **Import…** a different one on the fly. If
the file doesn't match the image stack a warning is shown and the quiz
still loads. Works the same across desktop, iPad and phones as the
annotator.

**Showcase files** render read-only: a sortable "All annotations" list
(slice order / type / title A–Z / Z–A) navigates to each feature's
slice and shows its full content — for MCQs, every option is shown
with the correct one highlighted. Multi-slice annotations appear on
each slice in their range.

**Quiz files** walk the student through the items **one at a time**:

1. A start screen says how many items there are and what to do.
2. The current item's prompt (a label's text, a pin's title, an MCQ's
   question) is shown with a step counter. Label/pin items: scrub to a
   slice and tap the spot; the marker can be dragged; **Check
   placement** grades it (right slice range *and* inside that slice's
   zone). MCQs always sit at their true spot: pick an option and
   **Check answer**.
3. Feedback is immediate and escalates: a miss says whether it was the
   wrong slice or the wrong spot; after one miss the slice range is
   given (and highlighted under the slider); after two the accepted
   zone is outlined; after three (two for MCQs) **Show me** reveals it,
   recorded as "shown" rather than solved.
4. **Skip** moves on; any item can be reopened from the Progress list,
   whose status glyphs are ring (not started), dot (attempted), dash
   (skipped), tick (correct) and cross (shown).
5. **Summary** lists every item with how many tries it took and lets
   the student retry any of them; **Start over** clears everything.

Progress is saved in the browser under a key made from the image
stack's fingerprint and the annotations file's hash, so a reload
resumes where the student left off and a different file starts fresh.

With a browser stack in use, the quiz previews the annotator's current
autosaved work on it (so you can try a quiz before exporting), or the
annotations that came in the package when there is no such work — a
student's browser only ever has the latter. **Import…** in the quiz
accepts a package as well as an annotations file: the stack is stored
in the browser and reopens, with progress, on the next visit. If the
browser can't store it, the package is opened for that visit only and
a banner says so.

## Security

Packages are data from someone else: zip entry names are never used as
paths in the browser, slice names with a path separator or a leading
dot are refused, SVGs inside are sanitised on display like any other,
and `install_package.py` rejects absolute or `..` paths before writing
anything and verifies the fingerprint of what it unpacked. `serve.py`
answers GET and HEAD only.

The pages are static, so the attack surface is the files they load:

- **Slice SVGs** are shown inline (so `data-layer` shapes are real DOM
  nodes), which means an SVG could carry script. Every SVG goes through
  `Scanner.sanitizeSvg` in `shared/common.js`: it parses the file,
  copies only allow-listed elements and attributes into freshly
  created nodes, and drops everything else (`script`, `foreignObject`,
  `image`, `use`, `a`, animation elements, `on*` handlers, `style`
  with `url()`, and any `url()` that isn't a same-document `#id`).
  Raster slices are shown with `<img>` and need no sanitising.
- **Annotation files** (bundled, imported or autosaved) are validated
  field by field; nothing from them is written to the page unescaped.
- A **Content-Security-Policy** meta tag on every page restricts script
  to the folder's own files as a backstop.

What this does *not* give you: the quiz answers are in
`annotations.json`, readable by anyone who can open the page.

## Development and tests

```
npm install            # Playwright, for the browser tests
npm test               # end-to-end tests (headless Chromium, ~20 s)
npm run test:a11y      # visual-accessibility checks (~2 min, see below)
npm run test:py        # Python unit tests: manifest hashing, serve, package install, contrast maths
npm run check:contrast # APCA + WCAG 2.2 AA check of the colour tokens
npm run check:all      # all of the above
```

`tests/a11y.test.js` opens the start page and both tools in fourteen UI states at seven
viewports (1920 down to a 390px phone, tablets with touch) and, for
every interactive element, checks that nothing covers it, that it is
at least 24×24 CSS px (32 on touch), that it has an accessible name,
that it overlaps nothing else, and that keyboard focus shows a ring;
each state is repeated at 200% zoom (half viewport, device scale 2).
It runs in Chromium, and also in Firefox when Playwright's Firefox is
installed (`npx playwright install firefox`); Firefox matters because
it always draws spinner buttons inside number inputs, which is what
first hid the slice range fields.

The end-to-end tests cover the browser workflow as well: choosing
files and folders, the cleaned SVG import, stacks surviving a reload,
package export checked entry by entry, package import in both tools
(including altered, damaged and compressed zips, and blocked storage),
and fingerprint parity — a package exported by the browser is installed
by `install_package.py` and must produce the same `datasetHash`.

`shared/theme.css` holds every colour as a token on `:root`.
`scripts/check_contrast.py` checks each foreground/background pairing
the UI uses against APCA (Lc 75 body text, Lc 60 large/UI text, Lc 45
non-text) and WCAG 2.2 AA (4.5:1 text, 3:1 large text and non-text),
and exits non-zero on failure. When you add a colour, add its pairing
to `PAIRS` in that script. Marker placement still needs a pointer;
keyboard-only placement is the remaining accessibility gap.
