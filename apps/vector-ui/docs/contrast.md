# Vector Explorer: colour and contrast

The console draws with shell tokens only, named once in
`src/vector/colors.ts`. `tests/a11y.contrast.test.ts` measures each of them in
the six themes under `packages/shell/public/themes`, against both surfaces the
console sits on (`--rr-bg-default` and `--rr-bg-paper`). This page records the
measurements, so the rules below are decisions with numbers behind them. The
map's colours are measured by the map's own suite.

## Rules

- **All text is `--rr-text-primary`**: figures, document rows, chunk text,
  chips, footers, the drawer and the dialogs. Hierarchy comes from size and
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
