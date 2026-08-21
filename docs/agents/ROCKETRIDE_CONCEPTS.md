# RocketRide Concepts — the shared model

Everything in this file is true across the whole platform — apps, pipelines,
and every artifact you deploy. The vertical guides (ROCKETRIDE_PIPELINES.md,
ROCKETRIDE_APPS.md) assume you know this file.

## The solution model

A person uses an **app**. The app runs **pipelines**. Pipelines compose
**pipeline components**. Three layers, three contracts between them:

```text
person ──> app (React, shell UI) ──> pipeline (.pipe, runs on the server)
                                          └──> pipeline components (catalog)
```

- The **app ↔ pipeline seam** is the SDK: the app imports a `.pipe` file as
  JSON, starts it with `client.use({ pipeline })`, holds the returned task
  token, and talks to the running task with `send` / `chat` / file uploads
  while streaming results back through events.
- The **pipeline ↔ component seam** is the catalog: each component in a
  `.pipe` names a `provider` from `.rocketride/services-catalog.json`, its
  config obeys `.rocketride/schema/<provider>.json`, and connections are typed
  lane matches.
- The **app ↔ platform seam** is the shell: apps import UI components, hooks,
  and the connection from the `'shell'` package and render inside an
  `AppLayout`.

## The workspace

A RocketRide workspace has three project directories by convention — `./apps`
(app projects), `./pipelines` (standalone `.pipe` files), and `./nodes`
(reserved for future custom pipeline components) — plus the `.rocketride/`
directory the platform maintains for you: this documentation, the component
catalog and schemas, and the vendored `shell` package that apps build against.
Treat `.rocketride/` as read-only; it is refreshed by the platform.

## The connection

All client traffic — SDK, apps, CLI, monitoring — travels over **one
websocket connection speaking DAP** to a RocketRide server (default port
5565). There is no REST API surface to discover: if you find yourself
composing HTTP requests, you are off the paved road. (The one exception:
file-download URLs handed out by the platform are plain HTTP redirects.)

- **Where**: `ROCKETRIDE_URI` — your own server (`ws://host:5565`) or
  RocketRide Cloud. In apps, the shell owns the connection; use the connection
  hooks rather than constructing clients.
- **Who**: `ROCKETRIDE_APIKEY` for scripts and headless services; interactive
  cloud login (OAuth/PKCE) for people. Both end in the same authenticated
  session.
- **Secrets are layered server-side**: an org admin can set environment
  secrets (API keys for LLM providers, database credentials) at the org,
  team, or user level; they merge server-side, most-specific wins, and
  pipelines resolve `${ROCKETRIDE_*}` substitutions against the merged set.
  A pipeline can therefore run with no local secrets at all.

### Credentials come from `.env` — the two-pair contract

You never construct an auth flow. The platform maintains the workspace
`.env` on every connection, and it can hold **two variable pairs**, one per
connection the editor manages:

| Pair | Connection | Use it for |
|---|---|---|
| `ROCKETRIDE_URI` / `ROCKETRIDE_APIKEY` | The **development** server (local engine, docker, or cloud) | Running, validating, iterating: `use()`, `send`/`chat`, uploads, monitors, the app dev loop |
| `ROCKETRIDE_DEPLOY_URI` / `ROCKETRIDE_DEPLOY_APIKEY` | The **deployment target** | Lifecycle verbs: `deploy.*` (versions, schedules, run history), `publishApp`/`submitApp`/review, build logs |

The rules:

- **Build clients from the pair that matches the verb family** — the two
  servers can be different machines (local dev engine, cloud deploy target).
- **The deploy pair's presence is the signal.** If `ROCKETRIDE_DEPLOY_*` is
  absent, no deployment target is configured: stop and ask the user to pick
  one — never deploy or publish to the development pair as a guess.
- **Both credentials are ordinary keys to you.** A cloud connection's value
  is the same persistent key the editor itself connects with; usage is
  identical to a self-hosted key. On an authentication error, do not retry
  or invent a flow — tell the user to reconnect (or sign in) in the editor,
  which rewrites `.env`.
- **Never copy `.env` credentials into CI or anything long-lived.** Headless
  automation (CI smoke tests, external schedulers, monitoring daemons) uses
  a key minted in Account → Keys, stored in that system's own secret store.

Mixed topology (local dev, cloud deploy) changes semantics, not just
addresses: a deployed artifact is self-contained payload and may not assume
local resources exist on the deploy server; schedules run on the **deploy
server's** clock and resolve secrets from **its** layered environment (not
your local `.env`); and task tokens returned by lifecycle verbs belong to
the deploy server — monitor those runs with a client on the deploy pair.

## Artifact lifecycle — deploy, publish, version

The same lifecycle vocabulary applies to every artifact kind the platform
serves (apps today, pipelines on the same rail, custom components in the
future). Learn it once:

- **Deploy** — copy an artifact to the server as the **next immutable
  registry version** (an integer: v1, v2, …). Deploying binds nothing and
  changes nothing a user sees. For apps the server also *builds* the deployed
  source; a failed build leaves the version unservable, with a build log to
  read. The registry version is not your semver — your package's display
  version rides along as metadata.
- **Publish** — bind one deployed version to one **audience rung**. The same
  verb covers first release, update, promotion, and rollback: publishing is
  *repointing*, never rebuilding.
- **Rungs** — `@me` (only you), `@team/<name>` (a team in your org),
  `@public` (the store). There is no org-wide rung. Internal rungs serve
  immediately; the public rung adds a **review ladder**.
- **Review state vs build status — two independent axes.** Review state is
  the human ladder: private → submitted → approved or rejected, with a
  two-way message thread between developer and reviewer. Build status is the
  machine axis: queued → building → ok or failed. An approved version with a
  failed build still cannot serve; a green build in review still waits for a
  human.
- **Versioned serving** — published apps serve from versioned, immutable
  URLs (`/apps/<appId>/v<N>/…`); which version an audience gets moves with
  its binding. This is why rollback is instant and why two users can be on
  different versions of the same app at once.

### Scheduled execution

Deployed pipelines (and only deployed pipelines — a pipeline embedded inside
an app package can never be scheduled) can run on a schedule:

- A schedule attaches to **one source of one team deployment** — each source
  of a project schedules independently.
- **`cron` fires the start; `ttl` bounds the window.** Cron cannot express
  "run from 8 to 3" — that is a cron start (`0 8 * * 1,3,5` for
  Mon/Wed/Fri 08:00) plus a ttl of 25200 seconds (7 h), after which the run
  is ended. Standard crontab syntax, validated at set time.
- Pausing a schedule keeps its cron and ttl configured; resuming picks them
  back up. An empty schedule means manual-only.

## Vocabulary that must stay precise

| Term | Means exactly | Never confuse with |
|---|---|---|
| deploy | version an artifact into the server registry | publish |
| publish | bind a deployed version to a rung | deploy |
| registry version | server-assigned integer (v1, v2 …) | your package semver |
| review state | private / submitted / approved / rejected | build status |
| build status | queued / building / ok / failed | review state |
| rung | `@me`, `@team/<name>`, `@public` | orgs (no org rung exists) |
| pipeline component | a node in a `.pipe` (`provider`) | UI component |
| UI component | a shell React component in an app | pipeline component |
| `.pipe` | the pipeline file format (JSON) | `client.use()` — the verb that runs one |
| task / token | one running pipeline instance and its handle | the pipeline definition |
| lane | a typed connection port on a pipeline component | React props |

Two more rules of the road: app ids are `<developerId>.<name>` and an org can
only deploy into its own claimed developer namespace; and version URLs are
constructed by the client from the version number — if you see code minting
or requesting signed entry URLs, it predates the current platform.

## Where execution happens

- **Pipelines run on the server** — always. Your script or app is a remote
  control holding a task token, not the executor. Closing your laptop does
  not stop a server task (unless its ttl ends it).
- **Apps run in the browser** (or a VS Code webview) against the shell.
  During development the App Builder serves your app live with hot reload;
  deployed versions are served from the store's immutable version
  directories.
- **Long CPU work in your own script blocks its websocket** — the connection
  keepalive will kill an event-loop-starved client. The API docs' Best
  practices sections carry the load-bearing guidance; read them before
  writing tight loops around SDK calls.
