# RocketRide

The OSS landing page and app launcher. This is the first screen you see when
you open a self-hosted RocketRide server in the browser: a branded top bar
around the shared desktop — greeting, rotating quote, and a card grid of every
app installed on the server.

---

## What it does

- **App launcher** — lists every app the server reports (except itself) as
  desktop cards, sorted by name. Clicking a card switches the workspace to
  that app.
- **Works signed out** — the app runs unauthenticated (`authenticated: false`).
  Logged out, it shows the app grid with a Sign In button; logged in, the same
  grid with a Sign Out button and the shared desktop's greeting and quote.
- **Top-bar chrome** — the RocketRide logo, a live GitHub star count for the
  server repo, a Discord link, and a sliding sun/moon theme toggle. The
  anonymous theme choice is persisted to `localStorage` (`rr:home:theme`) so
  the logged-out page keeps your preference; authenticated sessions use the
  account's own workspace theme.

The app is pinned to the OSS shell (`"shells": ["oss"]`) — the SaaS edition
has its own home.

---

## What it demonstrates

Although it ships as the OSS home, the source doubles as a compact example of
several shell patterns:

- A one-column app: a single root `AppLayout` with no sidebar and the status
  bar enabled, declared from the `app:` entry in `AppDescriptor.ts`.
- Reaching shell runtime through the curated `getShellApi()` contract
  accessor, including guarded probing for members (`DesktopView`) that may not
  exist on an older host — with a degraded fallback list instead of a crash.
- Workspace hooks: `useWorkspace()` for the app manifest, preferences, and
  `setTheme`.
- Shell bus events: `shell:switchApp`, `shell:loginRequest`, and
  `shell:logoutRequest` emitted through `ConnectionManager`.
- A plain external `fetch` (the GitHub stars badge) with a module-level,
  once-per-session cache.
