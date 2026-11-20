# Graph Explorer: colour and contrast

Labels are drawn in the shell's six chart colours, then a stable hash of the
label name (see `src/graph/colors.ts`). This page records what was measured so
the outline rule below is a decision with numbers behind it.

## Rules

- The connection's labels, sorted by code point, take `--rr-chart-blue`,
  `--rr-chart-green`, `--rr-chart-red`, `--rr-chart-orange`, `--rr-chart-purple`
  and `--rr-chart-yellow` in that order. The order keeps look-alikes apart: in a
  light theme read from a running shell, yellow (`#e67700`) and orange (`#e67a2e`)
  are nearly the same colour, and blue and purple are close, so yellow comes last
  and purple fifth. Every further label
  (and any label the schema snapshot does not know) takes `hsl(hue, 55%, 46%)`
  with the hue from an FNV-1a hash of the name, so a label keeps its colour for
  a given schema.
- **Every node has a 1 px outline in `--rr-text-primary`, in every theme, with
  no exception for colours that pass.** The outline is what separates a node
  from the page when its fill does not.
- Colour is never the only carrier of meaning. A node shows the first letter of
  its label, the legend lists every label next to its swatch, the spoken label
  of a node names its labels, and the inspector shows them.
- Caption text sits on the page (below the circle), in `--rr-text-primary`. The
  letter inside a circle is black or white, whichever reads better on the fill.

## Measurements

Contrast ratios (WCAG 2.x relative luminance) computed from the token values in
`packages/shell/public/themes/*.json`, against each theme's `--rr-bg-paper`.
Bold is below the 3:1 that WCAG 1.4.11 asks of graphical objects (unrounded; a
value printed as 3.00 that is bold is 2.998).

| Theme | Mode | Page (--rr-bg-paper) | blue | green | yellow | purple | orange | red | Outline / caption text on page |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| dark | dark | #242424 | 5.23 | 8.89 | 10.89 | 6.43 | 8.16 | 6.70 | 12.44 |
| gray | dark | #454545 | 3.23 | 5.49 | 6.73 | 3.97 | 5.04 | 4.14 | 7.40 |
| light | light | #ffffff | 4.98 | 4.37 | **3.00** | 5.55 | **2.92** | 5.46 | 17.40 |
| rocketride | dark | #161616 | 6.10 | 10.36 | 12.70 | 7.50 | 9.51 | 7.81 | 18.10 |
| rocketride-light | light | #e8e7e1 | 4.02 | 3.53 | **2.42** | 4.48 | **2.36** | 4.40 | 15.98 |
| visual-studio | light | #ffffff | 4.98 | 4.37 | **3.00** | 5.55 | **2.92** | 5.46 | 17.40 |

Best text colour on each chart-colour fill (black or white, whichever is higher):

| Theme | blue | green | yellow | purple | orange | red |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| dark | 7.08 (black) | 12.02 (black) | 14.73 (black) | 8.70 (black) | 11.03 (black) | 9.07 (black) |
| gray | 7.08 (black) | 12.02 (black) | 14.73 (black) | 8.70 (black) | 11.03 (black) | 9.07 (black) |
| light | 4.98 (white) | 4.81 (black) | 7.00 (black) | 5.55 (white) | 7.19 (black) | 5.46 (white) |
| rocketride | 7.08 (black) | 12.02 (black) | 14.73 (black) | 8.70 (black) | 11.03 (black) | 9.07 (black) |
| rocketride-light | 4.98 (white) | 4.81 (black) | 7.00 (black) | 5.55 (white) | 7.19 (black) | 5.46 (white) |
| visual-studio | 4.98 (white) | 4.81 (black) | 7.00 (black) | 5.55 (white) | 7.19 (black) | 5.46 (white) |


## What this shows

- In the three light themes the yellow and orange chart colours are below 3:1
  against the page (2.36 to 3.00). This is why the outline is unconditional:
  those nodes are only distinguishable from the page by their outline.
- Where one measured fill is below 3:1 against the page the outline colour
  itself is far above it (15.98 to 17.40 in the light themes), so the node's
  shape is always perceivable.
- Distinguishing two labels from each other still relies on more than hue: the
  initial letter, the legend and the spoken label carry it. This has not been
  checked with colour-vision-deficiency simulation; that remains a manual
  check in the browser acceptance lane.
- The theme tokens measured here are the ones shipped at the base commit; the
  test `tests/graph.colors.test.ts` re-measures them on every `graph-ui:test`
  run and fails if the outline colour stops clearing 4.5:1 against the page or a
  chart colour stops being readable under black or white text.

## Not claimed

Meeting a contrast ratio is not the same as meeting WCAG for the whole canvas.
Focus visibility, keyboard operation, reduced motion and screen-reader behaviour
are checked separately (README, "Accessibility").

## Accent, labels, pills and editor tokens

Measured by `tests/a11y.contrast.test.ts` against all six shipped themes, on both backgrounds the
canvas and its panels sit on (`--rr-bg-default` and `--rr-bg-paper`). The pairs are the constants in
`src/canvas/tokens.ts`, so changing a colour in the code changes what is measured.

- **Accent** (a highlighted relationship, the selection ring, the focus ring): `--rr-border-focus`,
  at least 3:1 everywhere (lowest: RocketRide Light 3.22:1 on paper). It replaced `--rr-brand`, which is
  1.9:1 against the page in RocketRide Light, so a highlighted path was fainter than an ordinary one. A
  highlighted relationship is also a thicker line (2 against 1.4), so colour is not the only difference.
- **Relationship type labels** (10 px): `--rr-text-primary`, at least 7.4:1. They were drawn in
  `--rr-text-secondary`, which is 3.8:1 in RocketRide Dark.
- **Inspector label pills**: `--rr-text-primary` on paper. The shell's chip draws its text in the info colour,
  3.46:1 on the panel in RocketRide Light.
- **Editor tokens and line numbers: measured, not applied at present.** The editor is the platform's shared
  Monaco editor, which sets its own theme (with no token colours) whenever it creates an editor and whenever
  the app theme changes, so an app cannot keep a theme of its own. The editor therefore shows Monaco's own
  `vs` / `vs-dark` token colours. Eleven of them are below 4.5:1 on the editor background in three themes
  (for example the label token `:Person`, 3.85:1 in RocketRide Light, and the comment colour, 2.42:1 in Gray),
  and the line numbers, drawn in `--rr-text-secondary`, are below it in RocketRide Dark. The fix is still
  computed and measured in `src/components/editorTheme.ts`: a failing token colour is moved along its own
  lightness until it reaches 4.5:1, the line numbers get the colour the token looks like over the paper and
  move only where that fails, and nothing is written per theme. It goes back into the editor once the shared
  editor accepts an app's token colours.
- Small secondary text elsewhere in the app uses the shell's `--rr-text-secondary`, which is a platform
  decision and is not restyled here.
