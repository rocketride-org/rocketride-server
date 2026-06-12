# tool_git

A RocketRide tool node that exposes git repository operations to an AI agent.

## What it does

Gives an agent safe, full-featured access to a git repository. The agent can open an
existing local repository, clone a remote one, or initialize a fresh one, then work with
the complete toolset: status and logs, diffs, staging and commits, branches, remotes, and
history search.

Uses **pygit2 / libgit2**: the libgit2 native library is bundled inside the pygit2 wheel,
so no host `git` binary is required on the machine running the engine.

Write operations are guarded by two toggles, **both on by default**: **read-only mode**
blocks all writes, and **safe mode** blocks force-push and force branch deletion. A
freshly added node can only inspect a repository until you turn read-only mode off.

---

## Configuration


| Field | Type | Description |
|---|---|---|
| `repoPath` | string | Default empty. Local path to an existing repository, or a remote URL (https://, git@, ssh://). A remote URL is cloned into a temporary directory at pipeline start and cleaned up on exit. Leave blank to let the agent call clone or init at runtime. |
| `authType` | string | Default "none". How to authenticate with remote repositories. |
| `username` | string | Default empty. Git username for token-based HTTPS authentication. |
| `token` | string | Default empty. Personal access token or password for HTTPS authentication. Leave empty when using SSH. |
| `sshKey` | string | Default empty. PEM-encoded SSH private key content (starts with -----BEGIN ...). Used when Auth Type is SSH. |
| `sshPassphrase` | string | Default empty. Passphrase for the SSH private key, if encrypted. Leave empty for unencrypted keys. |
| `safeMode` | boolean | Default true. Block destructive operations: force-push and force branch deletion. Normal branch deletion is allowed only when the branch is fully merged into HEAD; deleting an unmerged branch requires force=true (which is blocked in safe mode). Recommended for agent use. |
| `readOnlyMode` | boolean | Default true. Block ALL write operations (clone, init, write_file, stage, commit, stash push/pop/drop, branch create/delete, checkout, merge, fetch, pull, push). Read-only tools (status, log, show, diff, blame, file_at, branch_list, grep, ls_files, stash list) remain available. Strictly stronger than Safe Mode. Recommended when the agent only needs to inspect a repository. |


### repoPath: local path vs remote URL

`repoPath` is interpreted differently depending on its value:

| Value | Behaviour |
|-------|-----------|
| **Remote URL** (`https://`, `http://`, `git://`, `git@`, `ssh://`) | The repository is cloned into a temporary directory when the pipeline starts. The temp directory is deleted automatically when the pipeline ends. Use this for read-only analysis or ephemeral write workflows. |
| **Local path** | The existing directory is opened in place. No copy is made. Changes made by the agent persist on disk. |
| **Empty** | No repository is opened at startup. The agent must call `clone` or `init` as its first action. |

> **Note:** when using a remote URL with write operations (`push`), ensure `authType` and credentials are configured, since the cloned temp repo retains the remote `origin` from the URL.

---

## Available tools

### Repository


| Tool | Description |
|---|---|---|
| `clone` | Clone a remote git repository to a local path. Returns clone summary including the checked-out branch and HEAD SHA. |
| `init` | Initialise a new empty git repository at the given path. Creates the directory if it does not exist. |
| `status` | Return the working-tree status: current branch, staged files, unstaged modifications, and untracked files. |
| `log` | Return commit history. Supports filtering by branch, file path, author name, and date range. |
| `show` | Show full details of a single commit: metadata, diff patch, and file-change statistics. |
| `diff` | Produce a unified diff. Can diff working tree vs HEAD, two refs, or the staged index vs HEAD. |
| `blame` | Return per-line blame for a file: which commit and author last modified each line. |
| `file_at` | Return the raw content of a file at a specific commit or ref. |
| `write_file` | Write text content to a file in the working tree (creates or overwrites). Call stage then commit after writing to save the change. |
| `stage` | Stage files for the next commit (equivalent to git add). Deleted files are removed from the index. |
| `commit` | Create a commit from the current staged index. |
| `stash` | Manage the git stash. Operations: push, pop, list, drop. |
| `branch_list` | List local branches, and optionally remote-tracking branches. |
| `branch_create` | Create a new branch, optionally from a specific ref. |
| `checkout` | Check out an existing local branch. |
| `branch_delete` | Delete a branch. Normal deletion is always allowed. Force deletion (force=true) is blocked when safeMode=true. |
| `merge` | Merge a branch into the current branch. Fast-forwards if possible, otherwise creates a merge commit. Raises on conflicts. |
| `fetch` | Fetch updates from a remote without merging. |
| `pull` | Fetch from a remote and fast-forward merge the current branch. |
| `push` | Push the current (or specified) branch to a remote. Force-push is blocked unless safeMode=false. |
| `grep` | Search tracked file contents for a regex pattern. Returns file, line number, and matching line for each hit. Capped at max_results hits to keep responses bounded. |
| `ls_files` | List all tracked files in the repository, optionally filtered by path prefix. |


### Status & info

| Tool        | Description                                              |
|-------------|----------------------------------------------------------|
| `status` | Working-tree status: staged, unstaged, untracked files  |
| `log`    | Commit history with optional filters                    |
| `show`   | Full details + diff for a single commit                 |

### Diff & inspection

| Tool              | Description                                                        |
|-------------------|--------------------------------------------------------------------|
| `diff`        | Unified diff (working tree, two refs, or staged)                   |
| `blame`       | Per-line blame for a file                                          |
| `file_at`     | File content at a specific commit or ref                           |

### Working tree & commits

| Tool          | Description                         |
|---------------|-------------------------------------|
| `write_file` | Write text content to a file in the working tree (creates or overwrites) |
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

- **force push**: `push` with `force: true`
- **force branch deletion**: `branch_delete` with `force: true`

Normal branch deletion (`force: false`) is not gated by safe mode, but it only succeeds
when the branch is fully merged into `HEAD`; deleting an unmerged branch requires
`force: true`, which safe mode blocks. In practice, an unmerged branch cannot be deleted
while safe mode is on.

Set `safeMode: false` in the node config to allow force operations.

### Security note: write scope

Safe mode does **not** restrict file writes. Anything outside the `.git/` directory is fair game for `write_file`, including `.gitignore`, CI configs, build scripts, source files, and lockfiles. Path traversal (`../`) and writes inside `.git/` are blocked, but otherwise the agent has full read/write access to the working tree.

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

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `git.authType` | `string` | **Authentication Type**<br/>How to authenticate with remote repositories. | `"none"` |
| `git.readOnlyMode` | `boolean` | **Read-Only Mode**<br/>Block ALL write operations (clone, init, write_file, stage, commit, stash push/pop/drop, branch create/delete, checkout, merge, fetch, pull, push). Read-only tools (status, log, show, diff, blame, file_at, branch_list, grep, ls_files, stash list) remain available. Strictly stronger than Safe Mode. Recommended when the agent only needs to inspect a repository. | `true` |
| `git.repoPath` | `string` | **Repository Path**<br/>Local path to an existing repository, or a remote URL (https://, git@, ssh://). A remote URL is cloned into a temporary directory at pipeline start and cleaned up on exit. Leave blank to let the agent call clone or init at runtime. | `""` |
| `git.safeMode` | `boolean` | **Safe Mode**<br/>Block destructive operations: force-push and force branch deletion. Normal branch deletion is allowed only when the branch is fully merged into HEAD; deleting an unmerged branch requires force=true (which is blocked in safe mode). Recommended for agent use. | `true` |
| `git.sshKey` | `string` | **SSH Private Key**<br/>PEM-encoded SSH private key content (starts with -----BEGIN ...). Used when Auth Type is SSH. | `""` |
| `git.sshPassphrase` | `string` | **SSH Key Passphrase**<br/>Passphrase for the SSH private key, if encrypted. Leave empty for unencrypted keys. | `""` |
| `git.token` | `string` | **Token / Password**<br/>Personal access token or password for HTTPS authentication. Leave empty when using SSH. | `""` |
| `git.username` | `string` | **Username**<br/>Git username for token-based HTTPS authentication. | `""` |

## Dependencies

- `pygit2` `>=1.19.2`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_git)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
