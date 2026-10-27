# Docs site

The docs site at docs.rocketride.org is a static Docusaurus build. `./builder docs:build` gathers the pages from `docs/public`, the node READMEs, and the generated references, and writes the site to `dist/docs`; `.github/workflows/docs.yml` publishes that folder to GitHub Pages. `rr-verify docs` serves the same folder locally, so the pages you check are the files that would ship.

## Sub-features

- `docs-home` shows the `RocketRide Documentation` home page.
- `docs-nav` opens a page from the sidebar: **Get Started**, then **Overview**, lands on `/quickstart`.
- `docs-search` lists results for a search term in the search box.
- `docs-404` answers an unknown path with HTTP 404 and the `Page Not Found` page.

## How to get to it (user POV)

- Browse https://docs.rocketride.org. It is rebuilt from `develop` when docs change there, so it shows your change only after it merges.
- Follow a docs link from the VS Code extension, a node's `documentation` URL, or a README.

## Driving it with rr-verify

Preconditions:

- The site is built from this checkout: `./builder docs:build` finished and `rr-verify doctor` prints `ok   the docs site in dist/docs is newer than its sources`. A `WARN docs-site:` line means a source changed after the build; build again.
- Your run is live. The docs server belongs to the run, so `rr-verify stop` ends it.

- **Serve the site.** Run `rr-verify docs`. It prints a line starting `docs:     http://127.0.0.1:<port>` once the site answers. Running it again prints the same address.
- **Walk the site.** Run `rr-verify browse --label docs-site --site docs $F/browser/docs-site.mjs`. It opens `/`, waits for `RocketRide Documentation`, follows the sidebar to `/quickstart`, searches for `webhook` and counts the results, then opens `/no-such-page-rr-verify/` and expects HTTP 404 and `Page Not Found`. The output ends with `PASS: 17 step(s) passed`, with a screenshot of each page.
- **Search for your own term.** Run `rr-verify browse --label docs-search --site docs $F/browser/docs-site.mjs "<term>"`.
- **Check a page you changed.** Write a script like the example under "Browser scripts" in SKILL.md to `/tmp/rr-verify-$RR_VERIFY_ID-docs.mjs`: `open` your page's path, `waitText` a heading on it, `shot` it, and end with `expectNoErrors()` so a broken image or script fails the run. Run it with `rr-verify browse --label <feature-id> --site docs /tmp/rr-verify-$RR_VERIFY_ID-docs.mjs`.

## Gotchas

- `--site docs` is required. Without it, paths resolve against the engine, which answers `/` with the shell.
- `./builder docs:build` is not part of `./builder build`; run it yourself. It took about two minutes here on 2026-10-27.
- `./builder docs:serve` serves the same folder on the fixed port 3000. Use `rr-verify docs`, which picks a free port and is stopped with the run.
- The search box changes from a textbox to a combobox once it has text. Fill `role=textbox[name="Search"]`, then read `role=listbox >> role=option`.
- The 404 page keeps the home page's title, `RocketRide Documentation`, although its heading says `Page Not Found`. This is pre-existing (confirmed 2026-10-27): the site serves docs at `/`, and Docusaurus then renders unknown URLs without a page title.
