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

Layout:

```
annotator/   educator tool (index.html, app.js, style.css)
quiz/        student tool (index.html, app.js, style.css, annotations.json)
shared/      common.js (runtime shared by both) and theme.css (colour tokens + layout)
data/slices/ the image stack and its manifest.json
scripts/     build_manifest.py, generate_slices.py, check_contrast.py
tests/       Playwright end-to-end tests and Python unit tests
```

## Serving and hosting

The pages fetch their data, so they must be served over HTTP (opening
`index.html` from the file system shows an explanation instead):

```
python3 -m http.server 8000      # then open http://localhost:8000/annotator/
```

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

The slice list always comes from `data/slices/manifest.json`, but you
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
slice in it with the same zone. "Edit zone on: slice N only" switches
the position and tolerance controls (and marker dragging) to a
per-slice override for the current slice; adjusted slices are listed
with a reset button, and a dashed ring marks an overridden marker.
"This slice only" collapses the range back to one slice, keeping the
zone in effect on the slice you're looking at.

Annotations autosave to the browser's local storage as you work, in a
slot keyed by the image stack's fingerprint, so two copies of the tool
on one host with different stacks don't overwrite each other. If
storage is blocked or full, a banner says so (the work stays in memory
until you export). Work saved by the pre-fingerprint version is offered
for recovery once.

**Export annotations** first asks what the export is for, then
downloads a single `annotations.json` (schema below) for the quiz
tool to consume; **Import…** loads one back in for further editing,
validating every entry (bad ones are skipped and reported) and
converting older exports.

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

## Security

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
npm test               # end-to-end tests (headless Chromium, ~10 s)
npm run test:py        # Python unit tests: manifest hashing, contrast maths
npm run check:contrast # APCA + WCAG 2.2 AA check of the colour tokens
npm run check:all      # all three
```

`shared/theme.css` holds every colour as a token on `:root`.
`scripts/check_contrast.py` checks each foreground/background pairing
the UI uses against APCA (Lc 75 body text, Lc 60 large/UI text, Lc 45
non-text) and WCAG 2.2 AA (4.5:1 text, 3:1 large text and non-text),
and exits non-zero on failure. When you add a colour, add its pairing
to `PAIRS` in that script. Keyboard-only operation of marker placement
is not supported yet.
