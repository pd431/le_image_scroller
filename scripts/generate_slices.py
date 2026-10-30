#!/usr/bin/env python3
"""Generate a placeholder "apple cross-section" slice stack.

Each slice is a horizontal cut through an apple, scanned bottom to top.
The outer silhouette grows from a small base, peaks at the equator, then
narrows toward the stem; a star-shaped core with 5 seed pockets fades in
and out around the middle; a calyx dimple shows at the very bottom and a
stem nub at the very top. It's a stand-in for real cross-sectional
anatomy, chosen because a shape that visibly grows/shrinks with height
is much easier to read as "moving through a volume" than an abstract
rotating polygon - good enough to build/test the annotation and quiz
tools against.

Run: python3 scripts/generate_slices.py
Output: data/slices/slice-NNN.svg + data/slices/manifest.json
"""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from lib_manifest import build_manifest  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "slices")
SIZE = 400
CENTER = SIZE / 2
SLICE_COUNT = 40

# --- outer silhouette (skin), as a function of normalised height t in [0,1] ---
R_MAX = 150
EQUATOR_T = 0.45
APEX_MIN_R = 10
WOBBLE_AMOUNT = 0.045  # subtle 5-lobed silhouette, echoes the 5 carpels
SKIN_THICKNESS = 7

# --- core / seed chamber, star-shaped, fades in/out with height ---
CORE_MAX_R = 42
CORE_T_LOW = 0.08
CORE_T_HIGH = 0.88
CORE_PEAK_T = EQUATOR_T
CORE_INNER_RATIO = 0.55  # star inner-point radius as a fraction of outer

SEED_T_LOW = 0.24
SEED_T_MID_LOW = 0.38
SEED_T_MID_HIGH = 0.52
SEED_T_HIGH = 0.66
SEED_COUNT = 5
SEED_ORBIT_RATIO = 0.85  # fraction of core radius the seeds sit at
SEED_RX, SEED_RY = 7, 4

STEM_T_THRESHOLD = 0.93
CALYX_T_THRESHOLD = 0.07

COLORS = {
    "skin": {"fill": "#c1442d", "stroke": "#7a2415"},
    "flesh": {"fill": "#f3e6c6", "stroke": "#d8c496"},
    "core": {"fill": "#e4d98f", "stroke": "#b3a45f"},
    "seed": {"fill": "#3b2414", "stroke": "#1f1109"},
    "stem": {"fill": "#6b4a26", "stroke": "#40290f"},
    "calyx": {"fill": "#4a3018", "stroke": "#2a1a0c"},
}


def smoothstep(edge0, edge1, x):
    if edge0 == edge1:
        return 1.0 if x >= edge0 else 0.0
    t = max(0.0, min(1.0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)


def bump(low, peak, high, t):
    """0 -> 1 -> 0 smooth bump, 1 reached at `peak`."""
    if t <= low or t >= high:
        return 0.0
    rise = smoothstep(low, peak, t)
    fall = 1 - smoothstep(peak, high, t)
    return min(rise, fall)


def outer_radius(t):
    if t <= EQUATOR_T:
        u = t / EQUATOR_T
        r = R_MAX * math.sin(u * math.pi / 2 * 0.97)
    else:
        u = (t - EQUATOR_T) / (1 - EQUATOR_T)
        r = R_MAX * math.cos(u * math.pi / 2 * 0.90)
    return max(r, APEX_MIN_R)


def blob_points(radius, lobe_strength, n=48, inner_ratio=None, points=None):
    """A smooth n-gon, optionally lobed (outer silhouette) or a star
    (inner_ratio + points set for a 5-pointed core)."""
    pts = []
    if points:
        n = points * 2
        for k in range(n):
            r = radius if k % 2 == 0 else radius * inner_ratio
            angle = -math.pi / 2 + k * math.pi / points
            pts.append((CENTER + r * math.cos(angle), CENTER + r * math.sin(angle)))
    else:
        for k in range(n):
            angle = k * 2 * math.pi / n
            wobble = 1 + lobe_strength * math.sin(5 * angle)
            r = radius * wobble
            pts.append((CENTER + r * math.cos(angle), CENTER + r * math.sin(angle)))
    return " ".join(f"{x:.2f},{y:.2f}" for x, y in pts)


def render_slice(t):
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}" '
        f'width="{SIZE}" height="{SIZE}">',
        f'  <circle cx="{CENTER}" cy="{CENTER}" r="{CENTER - 5}" '
        f'fill="#0d1117" stroke="#30363d" stroke-width="2" />',
    ]

    core_amt = bump(CORE_T_LOW, CORE_PEAK_T, CORE_T_HIGH, t)
    lobe_strength = WOBBLE_AMOUNT * (0.3 + 0.7 * core_amt)

    skin_r = outer_radius(t)
    flesh_r = max(skin_r - SKIN_THICKNESS, 1)

    skin = COLORS["skin"]
    parts.append(
        f'  <polygon data-layer="skin" points="{blob_points(skin_r, lobe_strength)}" '
        f'fill="{skin["fill"]}" stroke="{skin["stroke"]}" stroke-width="2" '
        f'stroke-linejoin="round" />'
    )

    flesh = COLORS["flesh"]
    parts.append(
        f'  <polygon data-layer="flesh" points="{blob_points(flesh_r, lobe_strength)}" '
        f'fill="{flesh["fill"]}" stroke="{flesh["stroke"]}" stroke-width="1.5" '
        f'stroke-linejoin="round" />'
    )

    if core_amt > 0.02:
        core_r = CORE_MAX_R * core_amt
        core = COLORS["core"]
        parts.append(
            f'  <polygon data-layer="core" '
            f'points="{blob_points(core_r, 0, inner_ratio=CORE_INNER_RATIO, points=SEED_COUNT)}" '
            f'fill="{core["fill"]}" stroke="{core["stroke"]}" stroke-width="1.5" '
            f'stroke-linejoin="round" />'
        )

        seed_amt = bump(SEED_T_LOW, SEED_T_MID_LOW, SEED_T_MID_HIGH, t)
        seed_amt = max(seed_amt, bump(SEED_T_MID_LOW, SEED_T_MID_HIGH, SEED_T_HIGH, t))
        if t >= SEED_T_MID_LOW and t <= SEED_T_MID_HIGH:
            seed_amt = 1.0
        if seed_amt > 0.05:
            seed = COLORS["seed"]
            orbit = core_r * SEED_ORBIT_RATIO
            rx, ry = SEED_RX * seed_amt, SEED_RY * seed_amt
            for k in range(SEED_COUNT):
                angle = -math.pi / 2 + k * 2 * math.pi / SEED_COUNT
                sx = CENTER + orbit * math.cos(angle)
                sy = CENTER + orbit * math.sin(angle)
                parts.append(
                    f'  <ellipse data-layer="seed" cx="{sx:.2f}" cy="{sy:.2f}" '
                    f'rx="{rx:.2f}" ry="{ry:.2f}" transform="rotate({math.degrees(angle) + 90:.1f} '
                    f'{sx:.2f} {sy:.2f})" fill="{seed["fill"]}" stroke="{seed["stroke"]}" '
                    f'stroke-width="1" />'
                )

    if t > STEM_T_THRESHOLD:
        amt = smoothstep(STEM_T_THRESHOLD, 1.0, t)
        stem = COLORS["stem"]
        r = 4 + 7 * amt
        parts.append(
            f'  <circle data-layer="stem" cx="{CENTER}" cy="{CENTER}" r="{r:.2f}" '
            f'fill="{stem["fill"]}" stroke="{stem["stroke"]}" stroke-width="1.5" />'
        )

    if t < CALYX_T_THRESHOLD:
        amt = 1 - smoothstep(0.0, CALYX_T_THRESHOLD, t)
        calyx = COLORS["calyx"]
        r = 4 + 6 * amt
        parts.append(
            f'  <circle data-layer="calyx" cx="{CENTER}" cy="{CENTER}" r="{r:.2f}" '
            f'fill="{calyx["fill"]}" stroke="{calyx["stroke"]}" stroke-width="1.5" />'
        )

    parts.append("</svg>")
    parts.append("")
    return "\n".join(parts)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    for i in range(SLICE_COUNT):
        t = i / (SLICE_COUNT - 1)
        filename = f"slice-{i + 1:03d}.svg"
        with open(os.path.join(OUT_DIR, filename), "w") as f:
            f.write(render_slice(t))

    # Rebuilding from a directory scan (rather than just the files this
    # run wrote) means any other images already sitting in OUT_DIR are
    # picked up too, alphabetically alongside the generated ones.
    manifest = build_manifest(OUT_DIR, overrides={
        "size": SIZE,
        "axis": "height, bottom to top",
        "layers": [
            {"id": "skin", "label": "Skin"},
            {"id": "flesh", "label": "Flesh"},
            {"id": "core", "label": "Core"},
            {"id": "seed", "label": "Seed"},
            {"id": "stem", "label": "Stem"},
            {"id": "calyx", "label": "Calyx (blossom end)"},
        ],
    })

    print(f"Wrote {SLICE_COUNT} apple slices; manifest.json now lists {manifest['sliceCount']} image(s) total from {os.path.abspath(OUT_DIR)}")


if __name__ == "__main__":
    main()
