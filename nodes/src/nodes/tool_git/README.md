# tool_git

A RocketRide tool node that exposes local git repository operations to an AI agent.

Uses **pygit2 / libgit2** — the libgit2 native library is bundled inside the pygit2 wheel,
so no host `git` binary is required on the machine running the engine.

---

## Configuration

| Field           | Type    | Description                                                      |
|-----------------|---------|------------------------------------------------------------------|
| `repoPath`      | string  | Local path **or** remote URL (see below). Leave blank to let the agent call `git.clone` / `git.init` at runtime. |
| `authType`      | enum    | `none` · `token` · `ssh`                                        |
| `username`      | string  | Git username (used with token auth, e.g. `"git"` for GitHub)    |
| `token`         | string  | Personal access token or password (token auth)                  |
| `sshKey`        | string  | PEM-encoded SSH private key content (SSH auth)                  |
| `sshPassphrase` | string  | Passphrase for the SSH key (leave blank if none)                |
| `safeMode`      | boolean | Default `true`. Blocks force-push and force branch deletion.    |

### repoPath — local path vs remote URL

`repoPath` is interpreted differently depending on its value:

| Value | Behaviour |
|-------|-----------|
| **Remote URL** (`https://`, `http://`, `git://`, `git@`, `ssh://`) | The repository is cloned into a temporary directory when the pipeline starts. The temp directory is deleted automatically when the pipeline ends. Use this for read-only analysis or ephemeral write workflows. |
| **Local path** | The existing directory is opened in place. No copy is made. Changes made by the agent persist on disk. |
| **Empty** | No repository is opened at startup. The agent must call `git.clone` or `git.init` as its first action. |

> **Note:** when using a remote URL with write operations (`git.push`), ensure `authType` and credentials are configured — the cloned temp repo retains the remote `origin` from the URL.

---

## Available tools

### Repository

| Tool           | Description                                       |
|----------------|---------------------------------------------------|
| `git.clone`    | Clone a remote URL into a local path              |
| `git.init`     | Initialise a new empty repository                 |

### Status & Info

| Tool        | Description                                              |
|-------------|----------------------------------------------------------|
| `git.status` | Working-tree status: staged, unstaged, untracked files  |
| `git.log`    | Commit history with optional filters                    |
| `git.show`   | Full details + diff for a single commit                 |

### Diff & Inspection

| Tool              | Description                                                        |
|-------------------|--------------------------------------------------------------------|
| `git.diff`        | Unified diff (working tree, two refs, or staged)                   |
| `git.blame`       | Per-line blame for a file                                          |
| `git.file_at`     | File content at a specific commit or ref                           |
| `git.write_file`  | Write text content to a file in the working tree (creates or overwrites) |

### Staging & Commits

| Tool          | Description                         |
|---------------|-------------------------------------|
| `git.stage`   | Stage files (git add)               |
| `git.commit`  | Create a commit from staged index   |
| `git.stash`   | Push / pop / list / drop stash      |

### Branches

| Tool                | Description                          |
|---------------------|--------------------------------------|
| `git.branch_list`   | List local (and/or remote) branches  |
| `git.branch_create` | Create a branch from any ref         |
| `git.checkout`      | Check out an existing branch         |
| `git.branch_delete` | Delete a branch                      |
| `git.merge`         | Merge a branch into the current one  |

### Remote

| Tool        | Description                                 |
|-------------|---------------------------------------------|
| `git.fetch` | Fetch from a remote                         |
| `git.pull`  | Fetch + fast-forward merge                  |
| `git.push`  | Push to a remote (force-push blocked in safe mode) |

### Search

| Tool           | Description                                        |
|----------------|----------------------------------------------------|
| `git.grep`     | Regex search across tracked file contents          |
| `git.ls_files` | List tracked (and optionally untracked) files      |

---

## Safe mode

When `safeMode` is `true` (the default), the following operations raise an error instead of executing:

- **force push** — `git.push` with `force: true`
- **force branch deletion** — `git.branch_delete` with `force: true`

Normal branch deletion (`force: false`) is always permitted regardless of safe mode.

Set `safeMode: false` in the node config to allow force operations.

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
