# RocketRide — The `rocketride` command line

The `rocketride` command is installed with the SDK in either language
(`pip install rocketride` or `npm install rocketride`; use `pnpm exec
rocketride` / `npx rocketride` for local installs). The Python and
TypeScript packages install the IDENTICAL command — same verbs, same flags,
same output — so recipes port between languages unchanged.

**When to use it.** You have a shell. Prefer the command for every one-shot
lifecycle operation — validate, run, upload, store, deploy, publish,
schedule, scaffold — and write SDK code only for what the command cannot
do. It reads the workspace `.env`, works against a local engine with no
network, and needs no client configuration of any kind.

**Common options** (every command): `--uri <uri>` (default:
`ROCKETRIDE_URI` or `http://localhost:5565`), `--apikey <key>` (default:
`ROCKETRIDE_APIKEY`), and `--json [file]` — the command's entire result
as one JSON value on stdout (or written to `file`), built for scripts and
agents; failures become an `{"error": {"message", "hint"}}` envelope with
a non-zero exit. Deploy verbs (`deploy *`, `app deploy`) use the
`ROCKETRIDE_DEPLOY_*` pair instead and refuse to run without it.

## The loop, as commands

| Step | Do this |
|---|---|
| Set up or refresh the workspace | `rocketride init` (first time and whenever the server changes); `rocketride login` when credentials are rejected |
| Find components and their config fields | Read `.rocketride/services-catalog.json` and `.rocketride/schema/` — synced by `init`; there is no lookup command (ROCKETRIDE_COMPONENT_REFERENCE.md explains the shapes) |
| Validate a pipeline | `rocketride validate path/to/pipeline.pipe` (globs allowed) |
| Run a pipeline | `rocketride start --pipeline file.pipe` prints the task token; `rocketride upload files/* --pipeline file.pipe` starts, uploads, and terminates in one go |
| See what is running, stop it | `rocketride list`, `rocketride stop --token TOKEN` |
| Read run logs and traces | No CLI verb — use the SDK (`client.log`, API doc §Templates & Run Logs) or ROCKETRIDE_OBSERVABILITY.md |
| Files in the account store | `rocketride store dir|type|write|rm|mkdir|stat` |
| Deploy, publish, schedule | `rocketride deploy …` (deployment target) |
| Apps | `rocketride app create|verify|deploy` (deployment target) |

Two things the table cannot hide: component discovery is file-based, and
run logs need the SDK. Everything else in the build-validate-run-deploy
loop is a command.

## Workspace commands

- `rocketride init` — provision the workspace end-to-end: sign in (see
  `login`), sync the services catalog + schemas, vendor `shell.tgz` and
  `rocketride.tgz` into `.rocketride/`, install this documentation set and
  the CLAUDE.md stub, and ensure `.gitignore` covers `.rocketride/` and
  `.env`. Idempotent — re-run any time to refresh against the connected
  server.
- `rocketride login [--deploy] [--apikey <key>]` — (re)authenticate and
  save credentials to `.env` (and make `.env` git-ignored in the same
  step). OSS servers take an API key; saas servers open the browser to
  sign in and mint a durable personal API key. Run it whenever a command
  reports rejected credentials. `--deploy` targets the
  `ROCKETRIDE_DEPLOY_*` pair.

## Validate

```bash
rocketride validate pipelines/ingest.pipe            # one file
rocketride validate "pipelines/*.pipe"               # a glob
rocketride validate ingest.pipe --source <id>        # override the source component id
```

Validates against the connected server without executing anything. Exit 0
when every file passes; failures name the file and the problem. Run it
after every edit to a `.pipe` file — it is the fastest health check there
is.

## Task commands

```bash
rocketride list                                            # one-shot list of your active tasks
rocketride start --pipeline ./my-pipeline.pipe             # start; prints the task token and exits
rocketride upload files/*.csv --pipeline ./pipeline.pipe   # start + upload + terminate
rocketride upload files/*.csv --token TASK_TOKEN           # upload into an already-running task
rocketride stop --token TASK_TOKEN                         # terminate a task
```

- `start` options: `--pipeline <file>` (or `ROCKETRIDE_PIPELINE`; required), `--token <token>` (or `ROCKETRIDE_TOKEN`), `--threads <num>` (default 4), `--args <args...>`
- `upload` options: `--pipeline <file>` or `--token <token>` (one required), `--threads <num>` (default 4), `--max-concurrent <num>` (default 5), `--args <args...>`

There is no live-monitor command: continuous monitoring belongs to the
platform's event monitor and server monitor apps — the CLI is one-shot,
line-oriented output by design.

## Store commands (`rocketride store ...`)

File store operations against the account cloud store:

```bash
rocketride store dir [path]                       # list directory contents (DOS-style listing)
rocketride store type <path>                      # print file contents
rocketride store write <path> --file local.bin    # upload a local file
rocketride store write <path> --content "text"    # write inline text
rocketride store rm <path>                        # delete a file
rocketride store mkdir <path>                     # create a directory
rocketride store stat <path>                      # file/directory metadata
```

All store subcommands take the common `--uri`/`--apikey` options.

## App commands (`rocketride app ...`)

`app deploy` is a **deployment-target** verb: it defaults to the
`ROCKETRIDE_DEPLOY_URI` / `ROCKETRIDE_DEPLOY_APIKEY` pair and refuses to
run when no deployment target is configured. `app create` reads the
development connection (`ROCKETRIDE_URI`) for vendoring; `app verify`
needs no connection.

- `rocketride app create <slug> [--template Blank|Dashboard] [--name <text>]
  [--developer <id>] [--sidebar] [--no-status-footer] [--doc-tabs]
  [--workspace <dir>] [--no-install]` — scaffold a new app under
  `./apps/<slug>` with the same
  templates as the App Builder wizard, vendoring the platform packages
  from the development server (`ROCKETRIDE_URI`). SDK equivalent:
  `client.deploy.createApp(slug, options)` / `client.deploy.create_app`.
  Scaffolding only — nothing deploys.
- `rocketride app verify <folder> [--workspace <dir>]` — the
  no-side-effect precheck: manifest shape, id grammar, declared assets,
  include entries, and a pack dry run against the caps. Exit 0 when ready,
  1 with FAIL lines when not. Needs no server connection at all.
- `rocketride app deploy <folder> [--workspace <dir>] [--comment <text>]
  [--verbose]` — pack the app folder's source (App Builder rules:
  workspace-rooted layout, `appManifest.include`, gitignore + baseline
  filtering, size caps) and deploy it as the next registry version;
  `--verbose` narrates every pack step. Deploying activates nothing —
  publish a rung to serve it.

```bash
# CI: precheck, then deploy the packed source as the next registry version
rocketride app verify ./apps/reports
rocketride app deploy ./apps/reports --comment "ci: $GITHUB_SHA"
```

## Deploy commands (`rocketride deploy ...`)

Deployment-target verbs (the `ROCKETRIDE_DEPLOY_*` pair), following the
platform vocabulary — **deploy** = version to the server's registry,
**publish** = bind a rung to a version:

```bash
rocketride deploy add pipelines/ingest.pipe --comment "v2 parse" [--deploy-to <teamId>]   # next registry version (--kind pipe|node; --deploy-to also points a team at it in the same call)
rocketride deploy publish <projectId> 3 --team <teamId>             # point the team at version 3
rocketride deploy list                                              # deployments overview
rocketride deploy get <projectId> --team <teamId>                   # one deployment's state + schedules
rocketride deploy versions <projectId>                              # registry versions
rocketride deploy artifact <projectId> <version>                    # fetch one registry version's artifact JSON
rocketride deploy history <projectId>                               # deploy/publish audit trail
rocketride deploy run <projectId> <sourceId> --team <teamId>        # trigger a run now
rocketride deploy schedule set <projectId> <sourceId> "0 9 * * 1-5" --team <teamId> --ttl 32400
rocketride deploy schedule pause <projectId> <sourceId> --team <teamId>
rocketride deploy schedule resume <projectId> <sourceId> --team <teamId>
rocketride deploy schedule preview "0 9 * * 1-5"                    # validate a cron + next firings
rocketride deploy log <appId> <version>                             # read an app version's build log
rocketride deploy enable|disable|remove <projectId> --team <teamId>
```

Every verb here fronts a `client.deploy.*` SDK method — prefer the API in
application code; the CLI is the one-shot form for terminals, CI, and
quick lifecycle operations (all verbs support `--json`).

## MCP, if your harness has a client for it

Every RocketRide engine also serves the build loop as MCP tools at
`http://<host>:5565/mcp` (`https://api.rocketride.ai/mcp` for cloud):
component lookup, validation, runs, logs and traces, store, and deploy —
but not `init`, `login`, or the app verbs. Claude Code, Cursor and others
can be pointed at it; setup and the tool list are on the site under
Connect → MCP → HTTP. The command line needs none of that setup, which is
why this document leads with it.
