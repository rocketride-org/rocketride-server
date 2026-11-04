# Hello World

The minimal RocketRide demo app. Opening it shows a single centered page: a
hero image (an astronaut waving by a campfire on the moon), a greeting line,
and a large "Hello World!" title. That is the whole app — it exists as the
smallest complete example of a shell app, not as a tool.

---

## What it does

- Renders one static page inside the shell, themed entirely with shell CSS
  variables so it follows the active light/dark theme.
- Runs without authentication (`authenticated: false`). Signed in, the
  greeting reads "Welcome, <your name>!"; signed out it says it is running as
  a public app.

---

## What it demonstrates

Read the source (three small files) as a template for a new app:

- `AppDescriptor.ts` — the Module Federation entry: the `AppDescriptor`
  exported as default, with `id` matching the manifest, `branding`, and the
  root component on `app:`. Includes the `react/jsx-dev-runtime` HMR anchor
  import every app needs, and a comment on why `branding` carries no icons
  (branding icons would outrank the manifest icon).
- `HelloApp.tsx` — a frame-only layout: `AppLayout` with an empty sidebar
  node, which keeps the shell's branded sidebar frame (header and account
  footer) with an empty middle slot, plus the status bar.
- `ShellAppProps` — reading the `identity` prop to branch between
  authenticated and anonymous rendering.
- Bundled static assets — importing a local `.webp` image, with the ambient
  module declaration in `assets.d.ts`.
