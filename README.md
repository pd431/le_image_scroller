# Radiology Scanner (Moodle-friendly annotation + quiz tools)

A very lightweight pair of static, client-only tools (pure HTML/CSS/JS,
no server-side storage) built around a stack of sliced scan images:

1. **Annotator** (educator) — mark up features on a slice stack and
   export the annotations as a file.
2. **Quiz** (student) — load a slice stack + exported annotation file,
   and practice placing the known features on the correct slice.

Everything the site needs is just files in this folder — it can be
hosted as-is (e.g. as a Moodle-embeddable static page).

See **[guide.html](guide.html)** for a short, task-oriented walkthrough
of both tools — this README is the fuller technical reference.

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

Every annotation also carries an **acceptable range** — the tolerance
the quiz tool will use to judge a student's placement as correct. The
inspector's "Acceptable range" section offers two modes:

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

Annotations autosave to the browser's local storage as you work.
**Export annotations** first asks what the export is for, then
downloads a single `annotations.json` (schema below) for the quiz
tool to consume; **Import…** loads one back in for further editing.

- **Quiz vs. showcase** — Quiz: students place the features themselves
  and get checked. Showcase: a read-only walkthrough of the annotated
  slices (no placing, everything is already shown).
- **Quiz mode** (quiz exports only) — **Full challenge**: students
  must find both the right slice and the right spot. **Guided**:
  students are shown which slice each feature is on (via small markers
  on the quiz tool's slider) and only need to find the right spot.

```jsonc
{
  "version": 2,
  "exportMode": "quiz", // or "showcase"
  "quizMode": "guided", // "full" | "guided" - only present when exportMode is "quiz"
  "dataset": { "size": 400, "sliceCount": 40, "axis": "height, bottom to top" },
  "annotations": [
    { "id": "…", "type": "label", "sliceIndex": 18, "layer": "core", "x": 0.5, "y": 0.5, "text": "Core",
      "tolerance": { "mode": "radius", "radius": 0.06 } },
    { "id": "…", "type": "pin", "sliceIndex": 18, "layer": "flesh", "x": 0.28, "y": 0.5,
      "title": "Flesh", "description": "…",
      "tolerance": { "mode": "radius", "radius": 0.2 } },
    { "id": "…", "type": "mcq", "sliceIndex": 18, "layer": "flesh", "x": 0.5, "y": 0.38,
      "question": "What condition does this point to?",
      "options": ["Rot", "Bite mark", "Healthy apple"], "answer": "Healthy apple",
      "tolerance": { "mode": "polygon", "polygon": [{ "x": 0.42, "y": 0.35 }, { "x": 0.58, "y": 0.35 }, { "x": 0.58, "y": 0.55 }, { "x": 0.42, "y": 0.55 }] } }
  ]
}
```

`x`/`y` (and polygon point coordinates) are fractions (0–1) of the
slice image, so positions stay correct regardless of display size.
`tolerance.radius` is also a fraction of the image width.

## Quiz (`quiz/`)

The student-facing tool. Loads `quiz/annotations.json` (a static file
next to the page — replace it with your own export from the
annotator) by default, or **Import…** a different one on the fly.
Works the same across desktop, iPad and phones as the annotator.

**Showcase files** render read-only: a sortable "All annotations" list
(slice order / type / title A–Z / Z–A) navigates to each feature's
slice and shows its full content — for MCQs, every option is shown
with the correct one highlighted.

**Quiz files** show a "To place" list built from each annotation's
public-safe prompt (a label's text, a pin's title, an MCQ's question +
options) — never its slice or position. Tap a label/pin item (it
"arms"), then tap the slice where you think it belongs — or
press-and-drag it onto the stage, same as the annotator's palette.
Placed items can be dragged to reposition, or re-opened from the list
to review or clear. In **guided** exports, small dots below the slider
hint which slice each label/pin item belongs to (the currently-selected
item's dot is highlighted); a separate row of dots always shows which
slices you've placed something on.

**MCQs work differently, regardless of quiz mode**: an MCQ is a
question about a specific spot, not a test of whether you can find it,
so it's always shown already sitting at its true location and slice —
clicking it in the list jumps straight there (a slider hint for it
always shows too, even in *full challenge* exports) and all you do is
pick an answer from the dropdown.

Status icons in the list track each item: empty ring (not
placed/answered), filled dot (attempted, not yet checked), green check
/ red cross (graded). **Check my answers** grades every item at once —
label/pin: right slice *and* landing inside the annotation's
acceptable range (circle or custom polygon); MCQ: right dropdown
choice — and reveals the true location/content for anything attempted.
**Try again** clears every attempt and starts over.
