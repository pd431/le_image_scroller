#!/usr/bin/env python3
"""Check the colour tokens in shared/theme.css for contrast.

Every foreground/background pairing the UI uses is listed in PAIRS with its
role, and each is checked two ways:

* APCA (Accessible Perceptual Contrast Algorithm, WCAG 3 draft, 0.0.98G-4g):
  body text needs |Lc| >= 75, large or UI text >= 60, non-text >= 45.
* WCAG 2.2 AA contrast ratio: text >= 4.5:1, large text and non-text >= 3:1.

Exit status is non-zero when any pairing fails, so this can run in CI.
Run: python3 scripts/check_contrast.py [--verbose]
"""

import os
import re
import sys

THEME = os.path.join(os.path.dirname(__file__), "..", "shared", "theme.css")

# role: (APCA minimum |Lc|, WCAG minimum ratio)
ROLES = {
    "text": (75, 4.5),
    "large": (60, 3.0),
    "nontext": (45, 3.0),
}

# (foreground token, background token, role, where it is used)
PAIRS = [
    # body and panel text
    ("--text", "--bg", "text", "page text"),
    ("--text", "--bg-panel", "text", "panel text"),
    ("--text", "--bg-elevated", "text", "list items, palette"),
    ("--text", "--bg-control", "text", "buttons"),
    ("--text", "--bg-control-hover", "text", "buttons (hover)"),
    ("--text", "--bg-input", "text", "text inputs"),
    ("--text", "--bg-active", "text", "active list item"),
    ("--text-strong", "--bg-elevated", "text", "drag ghost"),
    ("--text-strong", "--bg-chip", "text", "label chip on stage (over stage bg)"),
    ("--text-strong", "--primary-bg", "text", "primary button"),
    ("--text-strong", "--primary-bg-hover", "text", "primary button (hover)"),
    ("--text-secondary", "--bg", "text", "dataset info in header"),
    ("--text-secondary", "--bg-panel", "text", "section headings, sort label"),
    ("--text-secondary", "--bg-elevated", "text", "pending outcome banner"),
    ("--text-secondary", "--bg-stage", "text", "missing-slice placeholder"),
    ("--text-muted", "--bg-panel", "text", "hints, meta"),
    ("--text-muted", "--bg-elevated", "text", "palette descriptions"),
    ("--text-on-pill", "--border-panel", "text", "count pill"),
    ("--text-on-pill", "--bg-panel", "text", "inspector field labels"),
    ("--link", "--bg", "text", "guide link"),
    ("--warn", "--bg-panel", "text", "drawing hint"),
    ("--danger-text", "--bg-control", "text", "danger button"),
    ("--danger-text", "--danger-bg-hover", "text", "danger button (hover)"),
    ("--info-text", "--info-bg", "text", "info notice"),
    ("--warn-text", "--warn-bg", "text", "warning notice"),
    ("--error-text", "--error-bg", "text", "error notice"),
    ("--success-text", "--success-bg", "text", "correct banner, correct answer"),
    ("--danger-text-strong", "--danger-bg", "text", "incorrect banner"),
    ("--accent-text", "--accent-bg", "text", "placed status icon"),
    # glyphs inside markers and icons (bold, decorative, treated as large/UI text)
    ("--pin-text-on", "--pin", "large", "pin marker glyph"),
    ("--mcq-text-on", "--mcq", "large", "MCQ marker glyph"),
    ("--accent-text-on", "--accent-strong", "large", "student marker glyph"),
    ("--success-text-on", "--success", "large", "correct marker glyph"),
    # non-text: markers, zones, ticks, control boundaries, focus ring
    ("--success", "--bg-stage", "nontext", "label marker on stage"),
    ("--pin", "--bg-stage", "nontext", "pin marker on stage"),
    ("--mcq", "--bg-stage", "nontext", "MCQ marker on stage"),
    ("--accent", "--bg-stage", "nontext", "zone outline"),
    ("--accent-strong", "--bg-stage", "nontext", "selected zone outline, student marker"),
    ("--danger", "--bg-stage", "nontext", "incorrect marker on stage"),
    ("--tick-active", "--bg-stage", "nontext", "revealed zone outline"),
    ("--warn", "--bg-stage", "nontext", "polygon draft line"),
    ("--tick", "--bg", "nontext", "slider hint ticks"),
    ("--success", "--bg", "nontext", "slider 'placed' ticks"),
    ("--tick-active", "--bg", "nontext", "slider active tick"),
    ("--border-input", "--bg-panel", "nontext", "text input boundary"),
    ("--border-ring", "--bg-elevated", "nontext", "unplaced status ring"),
    ("--accent-strong", "--bg", "nontext", "focus ring"),
    ("--accent-strong", "--bg-panel", "nontext", "focus ring on panels"),
    ("--success-border", "--success-bg", "nontext", "correct banner border"),
    ("--error-border", "--danger-bg", "nontext", "incorrect banner border"),
]


def parse_tokens(css):
    m = re.search(r":root\s*\{(.*?)\}", css, re.S)
    if not m:
        raise SystemExit("No :root block found in theme.css")
    tokens = {}
    for name, value in re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", m.group(1)):
        tokens[name] = value.strip()
    return tokens


def parse_colour(value):
    """Return (r, g, b, a) floats 0-1 for #rgb, #rrggbb or rgba()."""
    value = value.strip()
    if value.startswith("#"):
        h = value[1:]
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
        return r, g, b, 1.0
    m = re.match(r"rgba?\(([^)]+)\)", value)
    if m:
        parts = [p.strip() for p in m.group(1).split(",")]
        r, g, b = (float(p) / 255 for p in parts[:3])
        a = float(parts[3]) if len(parts) > 3 else 1.0
        return r, g, b, a
    raise ValueError(f"Unsupported colour: {value}")


def composite(fg, bg):
    """Alpha-composite fg over an opaque bg."""
    r, g, b, a = fg
    br, bg_, bb, _ = bg
    return (r * a + br * (1 - a), g * a + bg_ * (1 - a), b * a + bb * (1 - a), 1.0)


# --- APCA 0.0.98G-4g -----------------------------------------------------------

def apca_luminance(rgb):
    r, g, b, _ = rgb
    y = 0.2126729 * r ** 2.4 + 0.7151522 * g ** 2.4 + 0.0721750 * b ** 2.4
    if y < 0.022:
        y += (0.022 - y) ** 1.414
    return y


def apca_lc(text_rgb, bg_rgb):
    ytxt = apca_luminance(text_rgb)
    ybg = apca_luminance(bg_rgb)
    if ybg > ytxt:
        sapc = (ybg ** 0.56 - ytxt ** 0.57) * 1.14
        lc = 0 if sapc < 0.1 else sapc - 0.027
    else:
        sapc = (ybg ** 0.65 - ytxt ** 0.62) * 1.14
        lc = 0 if sapc > -0.1 else sapc + 0.027
    return lc * 100


# --- WCAG 2.x ---------------------------------------------------------------------

def wcag_luminance(rgb):
    def lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b, _ = rgb
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)


def wcag_ratio(a, b):
    la, lb = wcag_luminance(a), wcag_luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def main(argv):
    verbose = "--verbose" in argv
    with open(THEME) as f:
        tokens = parse_tokens(f.read())

    # Translucent backgrounds are composited over the stage background,
    # which is the only place they are used.
    stage = parse_colour(tokens["--bg-stage"])

    failures = []
    for fg_name, bg_name, role, where in PAIRS:
        missing = [n for n in (fg_name, bg_name) if n not in tokens]
        if missing:
            line = f"FAIL  {', '.join(missing)} not defined in theme.css ({where})"
            failures.append(line)
            print(line)
            continue
        fg = parse_colour(tokens[fg_name])
        bg = parse_colour(tokens[bg_name])
        if bg[3] < 1:
            bg = composite(bg, stage)
        if fg[3] < 1:
            fg = composite(fg, bg)

        lc = abs(apca_lc(fg, bg))
        ratio = wcag_ratio(fg, bg)
        min_lc, min_ratio = ROLES[role]
        ok = lc >= min_lc and ratio >= min_ratio
        line = (f"{'PASS' if ok else 'FAIL'}  {fg_name:>22} on {bg_name:<20} {role:<8}"
                f" Lc {lc:5.1f} (min {min_lc})  WCAG {ratio:4.2f}:1 (min {min_ratio})  {where}")
        if not ok:
            failures.append(line)
        if verbose or not ok:
            print(line)

    print(f"\n{len(PAIRS) - len(failures)} of {len(PAIRS)} pairings pass.")
    if failures:
        print(f"{len(failures)} failing.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
