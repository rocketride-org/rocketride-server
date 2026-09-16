# tool_tenki

A RocketRide tool node that gives an AI agent a disposable Linux VM for running code and shell
commands, editing files, and working in git repositories.

## What it does

Gives an agent a [Tenki Cloud Sandbox](https://tenki.cloud) session: a full Linux microVM, not a
container. Code runs on Tenki's infrastructure, never on the engine host. The node publishes 11
tools in three groups — **execution** (run commands and code), **filesystem** (write, read, list,
create and delete under `/home/tenki`) and **git** (clone, check out, diff, log).

One session is created **lazily** on the first tool call, so a pipeline that never invokes the tool
never provisions (or pays for) a VM. Files written and packages installed by one call are visible to
the next. The session ends on its idle pause and hard lifetime; see [Cost safety](#cost-safety) for
what actually shuts a VM down, which is not always the pipeline.

## Tenancy: read this before deploying

**The session belongs to the pipeline, not to a user.** A team-deployed pipeline is a single
instance that serves every caller, so everyone sharing that pipeline shares one VM, its files and
its installed packages. Anything one conversation leaves behind — including a modified shell
startup file, which a login shell runs before every later command — is visible to the next caller
until the session ends.

Run **one pipeline per user or per trust boundary**. The engine gives a tool call no caller
identity, so the node cannot separate callers itself.

For the same reason this node holds **no git credentials**. The sandbox user has passwordless
`sudo`, so any secret placed in the VM could be read by any command the agent runs and sent out
over the VM's open network. `git_clone` therefore works on **public repositories only**.

## Setup

1. In the Tenki console, open **API Keys** and create a workspace API key (it starts with `tk_`).
2. Set it as `tenki.apikey` on the node, or via `ROCKETRIDE_TENKI_APIKEY`.

The key stays on the engine and is never placed inside the sandbox.

---

## Configuration

| Field | Type | Description |
|---|---|---|
| `apikey` | string | **Required.** Tenki workspace API key, starting with `tk_`. |
| `base_url` | string | Default `https://api.tenki.cloud`. Passed explicitly so a key in the engine host's environment cannot decide which workspace is billed. |
| `cpu_cores` | integer | Default 2 (1–16). |
| `memory_mb` | integer | Default 4096 (512–65536). Rounded down to an even number, which Tenki requires. |
| `disk_size_gb` | integer | Default 5 (5–100). |
| `idle_timeout_minutes` | integer | Default 5 (1–120). Tenki **pauses** an idle session; it does not delete it. This is the first thing that stops compute on a VM the pipeline walked away from, so keep it low. |
| `max_duration_minutes` | integer | Default 60 (1–1440). Hard lifetime for **each** session, enforced by Tenki. This is the **only guaranteed** end for a VM: the engine does not always run node teardown (see [Cost safety](#cost-safety)). It does not cap total spend: once a session ends, the next call starts a new one. |
| `exec_timeout_secs` | integer | Default 120 (1–1200). Longest a single `run_command` / `run_code` may take. Also the floor for the API call deadline, which is never below 60s. |
| `max_output_chars` | integer | Default 50000 (1000–1000000). Longer output is truncated before it reaches the agent, protecting its context window. |
| `image` | string | Default empty. A Tenki image reference to start sessions from, instead of the base image. |
| `toolGroups` | array | Default empty, which publishes all three groups. Name groups to publish only those. |

### Tool groups

Every tool is tagged with a group, and only the published groups are visible to the agent: a tool
that is not published is invisible to `tool.query` and refused by `tool.invoke`. Leave the field
empty for all three, or narrow it — `["filesystem", "git"]` gives an agent a repository to read and
edit without letting it run commands. A value naming only unknown groups stops the pipeline at
startup rather than silently widening back to the default.

---

## Available tools

| Tool | Group | Description |
|---|---|---|
| `run_command` | execution | Run a shell command through a login shell. |
| `run_code` | execution | Write a snippet to a temporary file and run it (`python` or `javascript`). |
| `write_file` | filesystem | Write a UTF-8 text file, creating parent directories. |
| `read_file` | filesystem | Read a UTF-8 text file back, truncated at the output cap. |
| `list_files` | filesystem | List a directory. |
| `make_directory` | filesystem | Create a directory and its parents. |
| `delete_path` | filesystem | Delete a file or directory recursively. |
| `git_clone` | git | Clone a **public** repository into the sandbox. |
| `git_checkout` | git | Check out a branch, tag or commit. |
| `git_diff` | git | Show a diff. |
| `git_log` | git | Show commit history, bounded by `max_count`. |

Every file path is resolved under `/home/tenki` and confined to it. `run_code` supports `python`
(python3) and `javascript` (node). TypeScript is deliberately absent: `ts-node` is not in Tenki's
base image, and running a `.ts` file through it returned exit 0 with no output — a silent failure an
agent would read as success.

Execution tools return `exit_code`, `stdout`, `stderr`, `timed_out` and `truncated`. A command
stopped at its timeout comes back as a normal result with `timed_out: true`, not as an error.

---

## Session lifecycle

Tenki **pauses** an idle session rather than deleting it, and the node is built around that:

- **Paused** — memory and files under `/home/tenki` survive, but `/tmp` is cleared and open network
  connections drop. The next tool call resumes the session and retries automatically.
- **Ended** (past `max_duration_minutes`, or terminated) — the next call starts a fresh, empty
  session. Earlier files and installed packages are gone.

Because a silent retry would let an agent assume its earlier work is still there, any call that had
to recover the session reports it in a **`session`** field on the result: `"resumed"` (memory and
`/home/tenki` survived, `/tmp` was cleared) or `"replaced"` (fresh, empty session). A replacement is
also logged as a warning, because it costs a new VM.

Recovery follows the session's real state rather than the error alone: a paused session is resumed,
a terminated one is replaced, and anything else is surfaced to the agent unchanged.

---

## Cost safety

A running session bills by the minute, so the node bounds the exposure three ways.

**Enforced by Tenki**, and therefore guaranteed whatever the engine or the node does:

- **Idle pause** — Tenki pauses the session after `idle_timeout_minutes`, which stops compute billing.
- **Hard lifetime** — `max_duration_minutes` ends the session, whether or not anything closed it.

**In the node, on every run:**

- **Lazy creation** — a VM is provisioned only when a tool is actually called.
- **Bounded calls** — every control-plane call has a deadline and every command has a local wait
  limit, so a stalled connection cannot hang a call while the VM keeps billing.

**Best-effort, only when the engine runs node teardown:**

- **Explicit teardown** — `endGlobal` closes the session immediately.
- **Tagged sweep** — every session carries a tag unique to the pipeline run, and `endGlobal` closes
  any still running under it. This catches a session whose close did not take, and a create that
  raced its deadline and left a VM the node never received a handle for.

> **`endGlobal` does not always run.** A pipeline whose source is `chat` or `webhook` is force-killed
> when it is terminated or when its idle TTL expires: the source never observes the cancel, so the
> engine kills the task before node teardown. Measured on engine 3.3.0 with a probe node, both paths
> recorded `beginGlobal` and never `endGlobal`. For those pipelines the VM is **not** closed when the
> pipeline stops; it runs until `idle_timeout_minutes` pauses it and `max_duration_minutes` ends it.
> Size those two fields as if they were the only cleanup, because for a chat agent they are.

Sessions are named `rocketride-tool-tenki-<suffix>` and tagged `rocketride`, so anything orphaned is
recognisable in the Tenki console and can be closed there.

**`max_duration_minutes` caps each session, not total spend.** A long-running deployed pipeline that
keeps working will start a new session whenever one ends. To bound spend overall, give the pipeline
a dedicated Tenki workspace and key, and use that workspace's own quotas.

---

## Running the tests

```bash
# Unit tests (the Tenki SDK is stubbed — no API key and no network needed)
pytest nodes/test/test_tool_tenki.py -v

# Contract tests against the real SDK (skipped automatically when tenki is not installed)
pytest nodes/test/test_tool_tenki_sdk.py -v
```

The unit tests never call Tenki: a real session costs real money. `test_tool_tenki_sdk.py` checks
the SDK names, signatures and defaults this node depends on, so a `tenki` release that renamed one
fails there instead of in production.

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
