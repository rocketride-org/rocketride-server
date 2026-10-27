# Vector Explorer: colour and contrast

The console draws with shell tokens only, named once in
`src/vector/colors.ts`. `tests/a11y.contrast.test.ts` measures each of them in
the six themes under `packages/shell/public/themes`, against both surfaces the
console sits on (`--rr-bg-default` and `--rr-bg-paper`). This page records the
measurements, so the rules below are decisions with numbers behind them. The
map's colours are measured by the map's own suite.

## Rules

- **All text is `--rr-text-primary`**: figures, document rows, chunk text,
  chips, footers and the drawers. Hierarchy comes from size and
  weight, not from a lighter colour.
- **The accent is `--rr-border-focus`**: the focus ring of every control and
  the bar on the left of the selected row. It is the shell's own colour for
  "this is the active thing".
- **A selected row** is the paper mixed with 14 % of the accent, plus the 3 px
  accent bar, so a selection is told apart by more than its tint.
- **Chips carry their whole message in their label.** Their tone (success,
  info, warning, error, muted) is a 4 px edge in the status colour; the edge is
  decoration, never the only carrier of meaning.
- **Icons** (the trash button) draw in `currentColor`, which is the text token.
- Not used for text or graphics: `--rr-text-secondary`, `--rr-text-disabled`,
  the status colours (`--rr-color-*`) and `--rr-brand` (see below).

## Measurements

WCAG 2.x contrast ratios (relative luminance), each token composited over the
surface first. Default / paper. Text needs 4.5:1; graphics and focus
indicators need 3:1.

| Theme | Mode | Text (`--rr-text-primary`) | Accent (`--rr-border-focus`) | Text on a selected row | `--rr-text-secondary` | `--rr-color-warning` | `--rr-brand` |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| dark | dark | 14.50 / 12.44 | 4.83 / 4.14 | 10.51 | 7.61 / 6.53 | 7.84 / 6.72 | 3.91 / 3.35 |
| gray | dark | 8.78 / 7.40 | 4.33 / 3.65 | 6.16 | 5.49 / 4.62 | 4.93 / 4.15 | 4.33 / 3.65 |
| light | light | 17.40 / 17.40 | 4.53 / 4.53 | 14.40 | 5.74 / 5.74 | **1.84 / 1.84** | 6.40 / 6.40 |
| rocketride-light | light | 17.19 / 15.98 | 3.46 / 3.22 | 13.68 | 5.39 / 5.24 | **1.60 / 1.48** | **1.99 / 1.85** |
| rocketride | dark | 20.03 / 18.10 | 8.73 / 7.89 | 14.46 | **3.76 / 3.82** | 8.67 / 7.84 | 8.73 / 7.89 |
| visual-studio | light | 15.68 / 17.40 | 6.45 / 7.16 | 14.01 | 5.17 / 5.74 | **1.66 / 1.84** | 6.45 / 7.16 |

Bold is below the minimum the column would need: 4.5:1 for text in the
secondary column, 3:1 for the warning and brand columns as graphics.

## What this shows

- `--rr-text-primary` clears 4.5:1 everywhere, at 7.40:1 at worst (Gray, on
  the paper), and 6.16:1 on a selected row.
- `--rr-border-focus` clears 3:1 everywhere, at 3.22:1 at worst (RocketRide
  Light, on the paper). It is the one accent the console uses.
- `--rr-text-secondary` is 3.76:1 in RocketRide (dark): small text in it would
  fail, so the console writes no text in it.
- The status colours fall to 1.48:1 in the light themes, which is why a chip's
  tone is only an edge beside a label that says the same thing.
- `--rr-brand` is 1.85:1 in RocketRide Light, below even the 3:1 for graphics,
  so nothing is drawn in it.

## The map

The map is measured by its own suite, `tests/a11y.contrast.map.test.ts`, in
the same six themes and against both surfaces (the canvas sits on
`--rr-bg-default`, the panels and the boxes over it on `--rr-bg-paper`). Every
colour is measured as it is painted: a token that carries alpha is composited
over the surface first.

### Edges

The similarity edges (Edges: Neighbours or Tree, under Advanced) are drawn in
8 steps of similarity. Each step is stroked opaque in its own colour: the
surface mixed toward `--rr-text-primary`, the weakest step just far enough to
clear 3:1 on both surfaces, the strongest 80 % of the way. They used to be
`--rr-text-secondary` (already `rgba(255,255,255,0.40)` in RocketRide dark)
times an alpha ramp of 0.15 to 0.8, which painted the weakest edges at 1.1:1.

| Theme | Before: weakest / strongest (default) | Now: weakest (default / paper) | Now: strongest (default / paper) |
| --- | ---: | ---: | ---: |
| dark | **1.30** / 5.31 | 3.50 / 3.00 | 9.53 / 8.17 |
| gray | **1.32** / 4.14 | 3.56 / 3.00 | 6.25 / 5.27 |
| light | **1.23** / 3.69 | 3.03 / 3.03 | 9.15 / 9.15 |
| rocketride-light | **1.22** / 3.57 | 3.25 / 3.02 | 10.19 / 9.47 |
| rocketride | **1.12** / **2.77** | 3.33 / 3.01 | 12.73 / 11.50 |
| visual-studio | **1.21** / 3.46 | 3.03 / 3.36 | 8.64 / 9.59 |

These are the stroke colours. A line is anti-aliased across device pixels,
so a pixel at its side is nearer the surface than its colour. A stroke spans
at least two device pixels (`EDGE_DEVICE_PX`: 2 CSS px at 1 dppx, 1 CSS px at
2 dppx), and any two-pixel span holds one whole pixel, which carries the
colour above. A 1 px line at 1 dppx is spread over two pixels, so it rarely
does.

Measured in headless Chrome through the map's own `edgeTransform2d` and
`strokeEdgePaths`: 300 segments of the weakest bucket at random angles,
lengths and sub-pixel offsets, on the default surface, with 7 cross-sections
each. For each cross-section the table gives the contrast of its most
contrasting pixel, as painted. It shows the median, and the share under 3:1.

| Theme | Colour | Before: 1 px at 1 dppx | 1.5 px at 1 dppx | Now: 1 / 1.25 / 1.5 / 2 dppx |
| --- | ---: | ---: | ---: | ---: |
| rocketride-light | 3.25 | 2.33, 88 % under | 3.16, 35 % under | 3.25, 1.9-2.3 % under |
| rocketride | 3.33 | 2.33, 87 % under | 3.23, 30 % under | 3.33, 1.7-1.8 % under |
| light | 3.03 | 2.22, 97 % under | | 3.03, 6.0-6.4 % under |
| visual-studio | 3.03 | 2.22, 97 % under | | 3.03, 6.0-6.4 % under |
| dark | 3.50 | 2.50, 78 % under | | 3.50, 0.4-0.5 % under |
| gray | 3.56 | 2.65, 70 % under | | 3.56, 0.1 % under |

The median is the colour itself at every ratio. The links from the selected
point are half as heavy again as the edges (3 CSS px at 1 dppx, 1.5 at 2 dppx).
At 3 px every cross-section carries the accent whole: 3.46:1 in RocketRide
Light and 8.73:1 in RocketRide dark.

### Boxes over the map

The tooltip and the Advanced, Export and Views panels are the paper over the
map's surface (1.1:1 in RocketRide dark), so their edge is drawn: the paper
mixed toward the text colour until it clears 3:1 against both the paper and the
surface, with the theme's own `--rr-shadow-widget`. `--rr-border` was 1.38 /
1.24 in RocketRide dark; the computed border is 3.33 / 3.01 there and at least
3.00 everywhere.

### Marks

- **The accent** (`--rr-border-focus`: selection ring, links from the selected
  point, 3 px at 1 dppx and 1.5 px at 2 dppx, the query's star and rays, the lasso) clears 3:1
  everywhere, at 3.22:1 at worst (RocketRide Light, on the paper).
- **Outlier rings** are `--rr-text-primary`, 1.5 px, over a 4 px halo of the
  surface, so a ring reads over any point colour. The Outliers tab says
  "outlier" in words.
- **The star** is filled with the accent and edged with the surface.
- **A shown duplicate group** gets a dashed `--rr-text-primary` ring at each
  end of a pair, over a surface halo, and the pair's similarity with its scale
  ("cosine 0.99") in text with a halo.
- **Dimmed points and edges.** Hovering a point of a cluster (while clusters
  are shown), selecting a point, a highlighted set or a placed query fades the
  other points to 25 % of their colour over the surface (the same opaque mix
  in WebGL, in the Canvas2D fallback and in the PNG). An edge whose two ends
  are both faded is faded the same way, and so are an outlier ring or a
  near-duplicate line on faded points only; an edge, ring or line that touches
  the lit set keeps its measured colour. The selection, hover and keyboard
  focus rings are never faded. Faded marks fall below 3:1 on purpose: they
  are the part of the picture not being looked at. No label is drawn over a
  faded group.

### Similarity matrix

The cells are the chart blue over the surface, from 15 % (the least similar
pair) to 90 %. The lowest cell differs from an empty one by 1.18:1 at worst
(RocketRide dark); at 6 % it was 1.05:1. The values are printed in the cells at
11 px up to 12 x 12 (8.5 px before); above that each value is in its cell's
title, and the table alternative always holds every value.
