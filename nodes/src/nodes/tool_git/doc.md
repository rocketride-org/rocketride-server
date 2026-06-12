# tool_git

A RocketRide tool node that exposes local git repository operations to an AI agent.

Uses **pygit2 / libgit2** — the libgit2 native library is bundled inside the pygit2 wheel,
so no host `git` binary is required on the machine running the engine.

---

## Configuration

| Field           | Type    | Description                                                      |
|-----------------|---------|------------------------------------------------------------------|
| `repoPath`      | string  | Local path **or** remote URL (see below). Leave blank to let the agent call `clone` / `init` at runtime. |
| `authType`      | enum    | `none` · `token` · `ssh`                                        |
| `username`      | string  | Git username (used with token auth, e.g. `"git"` for GitHub)    |
| `token`         | string  | Personal access token or password (token auth)                  |
| `sshKey`        | string  | PEM-encoded SSH private key content (SSH auth)                  |
| `sshPassphrase` | string  | Passphrase for the SSH key (leave blank if none)                |
| `safeMode`      | boolean | Default `true`. Blocks force-push and force branch deletion.    |
| `readOnlyMode`  | boolean | Default `true`. Blocks **all** write operations. Strictly stronger than `safeMode`. |

### repoPath — local path vs remote URL

`repoPath` is interpreted differently depending on its value:

| Value | Behaviour |
|-------|-----------|
| **Remote URL** (`https://`, `http://`, `git://`, `git@`, `ssh://`) | The repository is cloned into a temporary directory when the pipeline starts. The temp directory is deleted automatically when the pipeline ends. Use this for read-only analysis or ephemeral write workflows. |
| **Local path** | The existing directory is opened in place. No copy is made. Changes made by the agent persist on disk. |
| **Empty** | No repository is opened at startup. The agent must call `clone` or `init` as its first action. |

> **Note:** when using a remote URL with write operations (`push`), ensure `authType` and credentials are configured — the cloned temp repo retains the remote `origin` from the URL.

---

## Available tools

### Repository

| Tool           | Description                                       |
|----------------|---------------------------------------------------|
| `clone`    | Clone a remote URL into a local path              |
| `init`     | Initialise a new empty repository                 |

### Status & Info

| Tool        | Description                                              |
|-------------|----------------------------------------------------------|
| `status` | Working-tree status: staged, unstaged, untracked files  |
| `log`    | Commit history with optional filters                    |
| `show`   | Full details + diff for a single commit                 |

### Diff & Inspection

| Tool              | Description                                                        |
|-------------------|--------------------------------------------------------------------|
| `diff`        | Unified diff (working tree, two refs, or staged)                   |
| `blame`       | Per-line blame for a file                                          |
| `file_at`     | File content at a specific commit or ref                           |
| `write_file`  | Write text content to a file in the working tree (creates or overwrites) |

### Staging & Commits

| Tool          | Description                         |
|---------------|-------------------------------------|
| `stage`   | Stage files (git add)               |
| `commit`  | Create a commit from staged index   |
| `stash`   | Push / pop / list / drop stash      |

### Branches

| Tool                | Description                          |
|---------------------|--------------------------------------|
| `branch_list`   | List local (and/or remote) branches  |
| `branch_create` | Create a branch from any ref         |
| `checkout`      | Check out an existing branch         |
| `branch_delete` | Delete a branch                      |
| `merge`         | Merge a branch into the current one  |

### Remote

| Tool        | Description                                 |
|-------------|---------------------------------------------|
| `fetch` | Fetch from a remote                         |
| `pull`  | Fetch + fast-forward merge                  |
| `push`  | Push to a remote (force-push blocked in safe mode) |

### Search

| Tool           | Description                                        |
|----------------|----------------------------------------------------|
| `grep`     | Regex search across tracked file contents          |
| `ls_files` | List tracked (and optionally untracked) files      |

---

## Safe mode

When `safeMode` is `true` (the default), the following operations raise an error instead of executing:

- **force push** — `push` with `force: true`
- **force branch deletion** — `branch_delete` with `force: true`

Normal branch deletion (`force: false`) is always permitted regardless of safe mode.

Set `safeMode: false` in the node config to allow force operations.

### Security note: write scope

Safe mode does **not** restrict file writes. Anything outside the `.git/` directory is fair game for `write_file` — including `.gitignore`, CI configs, build scripts, source files, and lockfiles. Path traversal (`../`) and writes inside `.git/` are blocked, but otherwise the agent has full read/write access to the working tree.

When pointing the node at a real repository (rather than a remote URL that auto-clones into a temp directory), treat the agent as a human contributor with commit rights to that tree. If you need stricter scoping, run the agent against a temp clone or a sandboxed working copy.

---

## Read-only mode

When `readOnlyMode` is `true` (the default), every mutating tool is blocked at dispatch and returns a JSON error. This is strictly stronger than `safeMode` and is the recommended setting when the agent only needs to inspect a repository.

Blocked tools: `clone`, `init`, `write_file`, `stage`, `commit`, `stash` (op `push` / `pop` / `drop`), `branch_create`, `checkout`, `branch_delete`, `merge`, `fetch`, `pull`, `push`.

Always allowed: `status`, `log`, `show`, `diff`, `blame`, `file_at`, `branch_list`, `grep`, `ls_files`, and `stash` with `op: "list"`.

Set `readOnlyMode: false` in the node config to allow write operations (subject to `safeMode`).

---

## Authentication

### Token (HTTPS)

Set `authType: token`, then provide `username` (e.g. `"git"` for GitHub/GitLab) and `token`
(personal access token or app password).

### SSH

Set `authType: ssh`, then paste the PEM-encoded private key content into `sshKey`.
If the key has a passphrase, set `sshPassphrase` as well.

The key content is written to a temporary file with `chmod 0400` during remote operations
and deleted immediately after.

---

## Running the tests

```bash
# Unit tests only (no git binary or real repo needed)
pytest nodes/test/tool_git/test_tools.py -v

# Integration tests against a real local repository
export GIT_TEST_REPO_PATH=/path/to/any/local/git/repo
pytest nodes/test/tool_git/test_tools.py -v
```

## Reference

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

- **Class type** — tool
- **Capabilities** — invoke
- **Protocol** — `tool_git://`

**Profiles**

- `default` — Git

**Configuration sections**

- **Git** — `type`, `git.repoPath`, `git.authType`, `git.username`, `git.token`, `git.sshKey`, `git.sshPassphrase`, `git.safeMode`, `git.readOnlyMode`

**Schema**

- **Repository Path** (`git.repoPath`) — `string`. Local path to an existing repository, or a remote URL (https://, git@, ssh://). A remote URL is cloned into a temporary directory at pipeline start and cleaned up on exit. Leave blank to let the agent call clone or init at runtime.
- **Authentication Type** (`git.authType`) — `string`, default `none`. How to authenticate with remote repositories.
- **Username** (`git.username`) — `string`. Git username for token-based HTTPS authentication.
- **Token / Password** (`git.token`) — `string`. Personal access token or password for HTTPS authentication. Leave empty when using SSH.
- **SSH Private Key** (`git.sshKey`) — `string`. PEM-encoded SSH private key content (starts with -----BEGIN ...). Used when Auth Type is SSH.
- **SSH Key Passphrase** (`git.sshPassphrase`) — `string`. Passphrase for the SSH private key, if encrypted. Leave empty for unencrypted keys.
- **Safe Mode** (`git.safeMode`) — `boolean`, default `true`. Block destructive operations: force-push and force branch deletion. Normal branch deletion is allowed only when the branch is fully merged into HEAD; deleting an unmerged branch requires force=true (which is blocked in safe mode). Recommended for agent use.
- **Read-Only Mode** (`git.readOnlyMode`) — `boolean`, default `true`. Block ALL write operations (clone, init, write_file, stage, commit, stash push/pop/drop, branch create/delete, checkout, merge, fetch, pull, push). Read-only tools (status, log, show, diff, blame, file_at, branch_list, grep, ls_files, stash list) remain available. Strictly stronger than Safe Mode. Recommended when the agent only needs to inspect a repository.

### Dependencies

- `pygit2` `>=1.19.2`

### Classes

**`IGlobal.py` — `IGlobal(IGlobalBase)`**

Global state for tool_git.

- `beginGlobal(self) -> None` — Initialise the GitRepo instance; clone remote URL or open local path if configured.
- `validateConfig(self) -> None` — Emit warnings for invalid authType, missing credentials, or a non-existent local repoPath.
- `endGlobal(self) -> None` — Release the repo reference and delete any auto-cloned temp directory.

**`IInstance.py` — `IInstance(IInstanceBase)`**

RocketRide tool node that exposes git operations to an AI agent via pygit2.

- `clone(self, args: Dict[str, Any]) -> Any` — Clone a remote repository.
- `init(self, args: Dict[str, Any]) -> Any` — Initialise a new empty repository.
- `status(self, args: Dict[str, Any]) -> Any` — Working-tree status.
- `log(self, args: Dict[str, Any]) -> Any` — Commit history with optional filters.
- `show(self, args: Dict[str, Any]) -> Any` — Show full commit details.
- `diff(self, args: Dict[str, Any]) -> Any` — Unified diff.
- `blame(self, args: Dict[str, Any]) -> Any` — Per-line blame.
- `file_at(self, args: Dict[str, Any]) -> Any` — File content at a specific ref.
- `write_file(self, args: Dict[str, Any]) -> Any` — Write text content to a file in the working tree.
- `stage(self, args: Dict[str, Any]) -> Any` — Stage files for the next commit.
- `commit(self, args: Dict[str, Any]) -> Any` — Create a commit from the staged index.
- `stash(self, args: Dict[str, Any]) -> Any` — Manage stash entries (push/pop/list/drop).
- `branch_list(self, args: Dict[str, Any]) -> Any` — List branches.
- `branch_create(self, args: Dict[str, Any]) -> Any` — Create a new branch.
- `checkout(self, args: Dict[str, Any]) -> Any` — Check out an existing branch.
- `branch_delete(self, args: Dict[str, Any]) -> Any` — Delete a branch.
- `merge(self, args: Dict[str, Any]) -> Any` — Merge a branch into the current branch.
- `fetch(self, args: Dict[str, Any]) -> Any` — Fetch from a remote.
- `pull(self, args: Dict[str, Any]) -> Any` — Fetch then fast-forward merge.
- `push(self, args: Dict[str, Any]) -> Any` — Push to a remote.
- `grep(self, args: Dict[str, Any]) -> Any` — Regex search across tracked files.
- `ls_files(self, args: Dict[str, Any]) -> Any` — List tracked files.

### Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> GitHub/tool_git](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_git)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
