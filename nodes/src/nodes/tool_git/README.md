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
