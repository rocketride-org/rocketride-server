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

| Property | Value |
| --- | --- |
| Class type | tool |
| Capabilities | invoke |
| Protocol | `tool_git://` |

**Profiles**

| Profile | Title | Model |
| --- | --- | --- |
| `default` | Git |  |

**Configuration sections**

| Section | Fields |
| --- | --- |
| Git | `type`, `git.repoPath`, `git.authType`, `git.username`, `git.token`, `git.sshKey`, `git.sshPassphrase`, `git.safeMode`, `git.readOnlyMode` |

**Schema fields**

| Field | Type | Title / Description | Const / Default |
| --- | --- | --- | --- |
| `git.repoPath` | string | Repository Path | default `` |
| `git.authType` | string | Authentication Type | default `none` |
| `git.username` | string | Username | default `` |
| `git.token` | string | Token / Password | default `` |
| `git.sshKey` | string | SSH Private Key | default `` |
| `git.sshPassphrase` | string | SSH Key Passphrase | default `` |
| `git.safeMode` | boolean | Safe Mode | default `true` |
| `git.readOnlyMode` | boolean | Read-Only Mode | default `true` |

**Dependencies**

`pygit2>=1.19.2`

**Classes**

`IGlobal` — extends `IGlobalBase` (`IGlobal.py`)

| Method | Summary |
| --- | --- |
| `beginGlobal(self) -> None` | Initialise the GitRepo instance; clone remote URL or open local path if configured. |
| `validateConfig(self) -> None` | Emit warnings for invalid authType, missing credentials, or a non-existent local repoPath. |
| `endGlobal(self) -> None` | Release the repo reference and delete any auto-cloned temp directory. |

`IInstance` — extends `IInstanceBase` (`IInstance.py`)

| Method | Summary |
| --- | --- |
| `clone(self, args: Dict[str, Any]) -> Any` | Clone a remote repository. |
| `init(self, args: Dict[str, Any]) -> Any` | Initialise a new empty repository. |
| `status(self, args: Dict[str, Any]) -> Any` | Working-tree status. |
| `log(self, args: Dict[str, Any]) -> Any` | Commit history with optional filters. |
| `show(self, args: Dict[str, Any]) -> Any` | Show full commit details. |
| `diff(self, args: Dict[str, Any]) -> Any` | Unified diff. |
| `blame(self, args: Dict[str, Any]) -> Any` | Per-line blame. |
| `file_at(self, args: Dict[str, Any]) -> Any` | File content at a specific ref. |
| `write_file(self, args: Dict[str, Any]) -> Any` | Write text content to a file in the working tree. |
| `stage(self, args: Dict[str, Any]) -> Any` | Stage files for the next commit. |
| `commit(self, args: Dict[str, Any]) -> Any` | Create a commit from the staged index. |
| `stash(self, args: Dict[str, Any]) -> Any` | Manage stash entries (push/pop/list/drop). |
| `branch_list(self, args: Dict[str, Any]) -> Any` | List branches. |
| `branch_create(self, args: Dict[str, Any]) -> Any` | Create a new branch. |
| `checkout(self, args: Dict[str, Any]) -> Any` | Check out an existing branch. |
| `branch_delete(self, args: Dict[str, Any]) -> Any` | Delete a branch. |
| `merge(self, args: Dict[str, Any]) -> Any` | Merge a branch into the current branch. |
| `fetch(self, args: Dict[str, Any]) -> Any` | Fetch from a remote. |
| `pull(self, args: Dict[str, Any]) -> Any` | Fetch then fast-forward merge. |
| `push(self, args: Dict[str, Any]) -> Any` | Push to a remote. |
| `grep(self, args: Dict[str, Any]) -> Any` | Regex search across tracked files. |
| `ls_files(self, args: Dict[str, Any]) -> Any` | List tracked files. |

`GitError` — extends `Exception` (`git_repo.py`)

`_TokenCallbacks` — extends `pygit2.RemoteCallbacks` (`git_repo.py`)

| Method | Summary |
| --- | --- |
| `__init__(self, username: str, token: str) -> None` | Store HTTPS credentials. |
| `credentials(self, url: str, username_from_url: Optional[str], allowed_types: int) -> pygit2.UserPass` | Return a UserPass credential object for libgit2. |

`_SshCallbacks` — extends `pygit2.RemoteCallbacks` (`git_repo.py`)

| Method | Summary |
| --- | --- |
| `__init__(self, key_content: str, passphrase: str) -> None` | Store SSH key material; temp file is created lazily in credentials(). |
| `credentials(self, url: str, username_from_url: Optional[str], allowed_types: int) -> pygit2.Keypair` | Write the SSH key to a temp file on first call and return a Keypair. |
| `close(self) -> None` | Delete the temporary key file if it was created. |

`GitRepo` (`git_repo.py`)

| Method | Summary |
| --- | --- |
| `__init__(self, *, repo_path: str, auth_type: str, username: str, token: str, ssh_key: str, ssh_passphrase: str, safe_mode: bool, read_only_mode: bool) -> None` | Configure the wrapper and optionally open an existing local repository. |
| `open(self, path: str) -> None` | Open an existing local repository at *path* and bind it to this wrapper. |
| `clone(self, url: str, path: str, branch: Optional[str]) -> Dict[str, Any]` | Clone *url* into *path*. |
| `init(self, path: str, initial_branch: str) -> Dict[str, Any]` | Initialise a new empty repository at *path*. |
| `status(self) -> Dict[str, Any]` | Return working-tree status. |
| `log(self, max_count: int, branch: Optional[str], path: Optional[str], author: Optional[str], since: Optional[str], until: Optional[str]) -> List[Dict[str, Any]]` | Return commit history. |
| `show(self, ref: str) -> Dict[str, Any]` | Return full commit details including diff. |
| `diff(self, ref_a: Optional[str], ref_b: Optional[str], path: Optional[str], staged: bool) -> Dict[str, Any]` | Produce a unified diff. |
| `blame(self, path: str, ref: Optional[str]) -> List[Dict[str, Any]]` | Return per-line blame for *path*. |
| `file_at(self, path: str, ref: str) -> Dict[str, Any]` | Return file content at a specific commit/ref. |
| `write_file(self, path: str, content: str) -> Dict[str, Any]` | Write *content* to *path* in the working tree (creates or overwrites). |
| `stage(self, paths: List[str]) -> Dict[str, Any]` | Stage files (add to index). |
| `commit(self, message: str, author_name: str, author_email: str) -> Dict[str, Any]` | Create a commit from the current index. |
| `stash(self, op: str, message: str, index: int) -> Dict[str, Any]` | Push, pop, list, or drop stash entries. |
| `branch_list(self, remote: bool, all_branches: bool) -> Dict[str, Any]` | List branches. |
| `branch_create(self, name: str, from_ref: Optional[str]) -> Dict[str, Any]` | Create a new branch. |
| `checkout(self, branch: str) -> Dict[str, Any]` | Checkout an existing branch. |
| `branch_delete(self, name: str, force: bool) -> Dict[str, Any]` | Delete a branch. |
| `merge(self, branch: str) -> Dict[str, Any]` | Merge *branch* into the current branch. |
| `fetch(self, remote: str, branch: Optional[str]) -> Dict[str, Any]` | Fetch from a remote. |
| `pull(self, remote: str, branch: Optional[str]) -> Dict[str, Any]` | Fetch then fast-forward merge. |
| `push(self, remote: str, branch: Optional[str], force: bool) -> Dict[str, Any]` | Push to a remote. |
| `grep(self, pattern: str, ref: Optional[str], path: Optional[str], ignore_case: bool, max_results: int) -> List[Dict[str, Any]]` | Search tracked files for a pattern. Stops after *max_results* hits. |
| `ls_files(self, path: Optional[str], untracked: bool) -> Dict[str, Any]` | List tracked (and optionally untracked) files. |

**Source**

[`nodes/src/nodes/tool_git`](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_git)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
