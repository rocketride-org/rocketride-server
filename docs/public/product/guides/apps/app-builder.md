---
title: App Builder
---

# App Builder

The App Builder is the workspace in the RocketRide VS Code extension that
takes an app from an empty folder to a version your team can open. It owns
the work that sits between an app that runs on your machine and one your
team can use: scaffolding the project, previewing it against a real engine
while you edit, packaging it, and deploying versions you can publish, all
without leaving the editor. If you are not yet sure what an app is or
whether you need one, read [Apps](/concepts/apps) first. Switch the
RocketRide sidebar to apps mode and pick an app, or open its `<name>.rrapp`
file, and the builder opens on it.

Where a step has a command-line equivalent, it is shown after the step, so
the same loop runs from a terminal or CI.

## Before you start

- The extension, installed and signed in
  ([installation](/clients/vscode/installation)).
- Node and **pnpm**. Use pnpm, not npm: running `npm install` inside an app
  folder can corrupt the workspace layout. Dependencies install once at the
  workspace root.
- A developer id for your organization. Every app id is
  `<developerId>.<name>`. Your organization claims its developer id once,
  on the Deploy tab (lowercase letters and underscores, starting with a
  letter), and can then deploy
  only apps inside that namespace. Until the prefix of your app's id
  matches, the Deploy tab is read-only with a banner; the fix is to rename
  the id in `package.json`. Design and Package always work.

## The loop

The builder's tabs, in the order you meet them the first time. After
that, you come back to Design and Deploy most often.

### Create (Dashboard tab)

Start from the Dashboard tab, or run **RocketRide: New App** from the
command palette. The wizard asks for a name and a template (Blank or
Dashboard) and scaffolds the app under `apps/<slug>`. Always create apps
this way; a hand-made folder fails later with symptoms far from the cause.
The scaffold starts the id at `local.<slug>` until your organization has a
developer id; renaming the id later makes it a different app.

The `<name>.rrapp` file it creates is empty on purpose. Opening it opens
the App Builder; the app's identity lives in `package.json`.

What you will edit:

| File | What it is |
| --- | --- |
| `package.json` | the app manifest (`appManifest`): id, name, icon, README, included folders |
| `README.md` | your listing text |
| `icon.svg` | your listing icon |
| `src/App.tsx` | the screens |
| `src/AppDescriptor.ts` | how the app presents itself to the shell |

```bash
rocketride app create reports --template Dashboard
```

### Design

The Preview pane is the real shell, running against your connected engine,
with your app loaded inside it. Every save rebuilds and reloads. The
bundle you are previewing is a personal overlay that only you can see, and
it disappears when the panel closes or the connection drops, so
development work never reaches other users. **Components** is a live
gallery of everything importable from `shell`, and **Console** shows your
app's own console output as it runs.

:::note If the preview keeps showing a sign-in screen
With **Inherit Auth** off, an app that requires sign-in boots signed out on
purpose; turn it on to reuse your session. If it still bounces, the host
session is stale: sign out of VS Code and back in, then reload the preview.
:::

### Package

The Package tab edits the `appManifest` block in `package.json`. The file
is the truth, so editing it by hand is fine. Verification needs no server:

```bash
rocketride app verify ./apps/reports
```

### Your listing

Your listing is `README.md` and `icon.svg`, declared in `appManifest`
(`readme` and `icon`) and editable on the Package tab or by hand. Both
files must live inside the app folder. Versions are immutable, so replace
the scaffold README before your first deploy.

### Deploy

Two verbs, and they are not the same:

- **Deploy** uploads your app's source; the server builds it into the next
  immutable version. Deploying activates nothing.
- **Publish** points an audience at a version: `@me` for your own desktop,
  `@team/<name>` for a team. First release, update, and rollback are all
  the same move: repoint, never rebuild. There is no org-wide rung; an
  org-wide audience is a team your admin maintains.

A deploy packs the app folder plus any folders listed under
`appManifest.include`, and nothing else. Every `include` entry must exist.

```bash
rocketride app deploy ./apps/reports --comment "first version"
```

`rocketride app deploy` needs a deployment target (`ROCKETRIDE_DEPLOY_URI`
and `ROCKETRIDE_DEPLOY_APIKEY`) and refuses to run without one; `app
create` uses the development connection (`ROCKETRIDE_URI`) to vendor
platform packages, and `app verify` needs no connection. Publishing
happens on the Deploy tab.

## Adding a pipeline to your app

There are two ways, and they are different features. See
[Apps and pipelines](/concepts/apps#apps-and-pipelines) for the idea; this
is the how-to.

### Inside the app: runs per user, on demand

Put the `.pipe` file in the app folder and import it. The scaffold's build
treats `.pipe` as JSON. Start it from the shell connection:

```typescript
import summarizer from './summarizer.pipe';
import { useShellConnection } from 'shell';

const { client } = useShellConnection();
const { token } = await client.use({ pipeline: summarizer, useExisting: true });
```

Every signed-in user gets their own instance. Start it once per session and
keep the token; `useExisting: true` re-attaches after a reload instead of
failing because the pipeline is already running. The pipeline ships with the
app on deploy. Use this for work that happens when the user asks for it.

### Outside the app: shared, on a schedule

Build the pipeline as its own project and deploy it separately:

```bash
rocketride deploy add pipelines/nightly-report.pipe --comment "v1"
rocketride deploy publish <projectId> 1 --team <teamId>
```

The app does not start this pipeline. It imports the `.pipe` for its
identity only and asks the shell client for the running task's token
(`getTaskToken`) to attach to the instance the team is running:

```typescript
import nightly from '../../../pipelines/nightly-report.pipe'; // identity only
const projectId = String(nightly.project_id);
```

Outside its schedule window there is no running instance and no token.
That is the normal state, not an error; show the feature as offline and
check again later. Deploying the app does not carry this pipeline, so
deploy it on its own whenever it changes.

| | Inside the app | Outside the app |
| --- | --- | --- |
| Where the `.pipe` lives | in the app folder | its own project |
| Who runs it | one instance per signed-in user | one instance for the team |
| When it runs | when the app asks | on its schedule |
| How it deploys | with the app | separately, `rocketride deploy` |

## Next steps

- [Shell API](/guides/apps): hooks, the descriptor, and the manifest, when
  you code by hand.
- [CLI](/connect/cli): the full command reference.
- Building with a coding agent? The bundle the extension installs already
  contains the complete app reference; point your agent at
  `ROCKETRIDE_APPS.md`.
