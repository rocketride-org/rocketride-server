# tool_github

A RocketRide tool node that exposes GitHub repository operations to an AI agent.

## What it does

Gives an agent full access to the GitHub REST API: files, issues, pull requests,
reviews, releases, workflows, organizations, users, search, and commit history. Useful
for agents that manage codebases, triage issues, automate releases, or operate CI/CD
pipelines.

Uses the **requests** library to call the GitHub REST API v3 (`https://api.github.com`,
API version `2022-11-28`) with Bearer-token auth and a 30-second request timeout. API
responses are stripped of noisy fields (`node_id`, `_links`, gravatar data, etc.) so the
agent gets compact, useful output.

A personal access token is **required**: the pipeline fails to start without one. Write
operations are **allowed by default**; enable **read-only mode** to block every mutating
tool when the agent should only inspect.

---

## Configuration


| Field | Type | Description |
|---|---|---|
| `token` | string | Default empty. GitHub PAT with repo, issues, pull_requests, and workflows scopes. Use a fine-grained token scoped to only the repos you need. |
| `defaultRepo` | string | Default empty. Default repo in owner/repo format (e.g. acme/myapp). Tool calls that omit the repo parameter will use this value. |
| `readOnly` | boolean | Default false. When enabled, all write operations (file create/edit/delete, issue create, PR create, etc.) are blocked. Safe for agents that should only read. |


### Repository resolution

Most tools accept an optional `repo` parameter (`owner/repo`). If omitted, the configured
`defaultRepo` is used; if neither is set, the call fails with an error asking for a repo.

> **Note:** `search_code` and `search_issues` also fall back to `defaultRepo`, when a
> default repo is configured, searches are scoped to it unless the call passes its own
> `repo`. To search across all accessible repositories, leave `defaultRepo` blank.

---

## Available tools

List tools accept `per_page` (1–100, default 30) and `page` (default 1) for pagination.

### Files


| Tool | Description |
|---|---|---|
| `file_get` | Get the decoded content and metadata of a single file from a GitHub repository. |
| `file_list` | List files and directories at a path in a GitHub repository. |
| `file_create` | Create a new file in a GitHub repository. |
| `file_edit` | Update an existing file in a GitHub repository. Requires the current file SHA (get it from file_get first). |
| `file_delete` | Delete a file from a GitHub repository. Requires the current file SHA (get it from file_get first). |
| `issue_get` | Get a single GitHub issue by number. |
| `issue_list` | List issues in a repository. Excludes pull requests. |
| `issue_create` | Create a new issue in a GitHub repository. |
| `issue_comment` | Post a comment on a GitHub issue. |
| `issue_edit` | Edit an existing GitHub issue (title, body, state, labels, assignees). |
| `issue_lock` | Lock a GitHub issue to prevent further comments. |
| `pr_get` | Get a single pull request by number. |
| `pr_list` | List pull requests in a repository. |
| `pr_create` | Create a new pull request. |
| `review_create` | Submit a review on a pull request (approve, request changes, or comment). |
| `review_list` | List all reviews on a pull request. |
| `review_get` | Get a single review on a pull request. |
| `review_update` | Update the body of a pending review on a pull request. |
| `repo_get` | Get metadata for a GitHub repository (stars, forks, language, default branch, etc.). |
| `release_list` | List releases for a repository. |
| `release_get` | Get a single release by ID. |
| `release_create` | Create a new release in a repository. |
| `release_update` | Update an existing release. |
| `release_delete` | Delete a release from a repository. |
| `workflow_list` | List all workflows in a repository. |
| `workflow_get` | Get a single workflow by ID or filename. |
| `workflow_dispatch` | Trigger a workflow_dispatch event to manually run a workflow. |
| `workflow_enable` | Enable a previously disabled workflow. |
| `workflow_disable` | Disable a workflow so it will not run. |
| `workflow_get_usage` | Get billable minutes and run counts for a workflow. |
| `org_list_repos` | List repositories belonging to a GitHub organization. |
| `user_get_repos` | List repositories for a user. Omit username to list the authenticated user's repos. |
| `user_invite` | Invite a user to a GitHub organization by email. |
| `search_code` | Search code across GitHub repositories. Returns matching file paths, repo, and a snippet. |
| `search_issues` | Search issues and pull requests across GitHub. Useful for finding bug reports and edge cases related to a node. |
| `commit_list` | List commits in a repository, optionally filtered to a specific file path. Useful for understanding what changed recently. |
| `commit_get` | Get a single commit including its diff stats and changed files. |


`file_get` raises an error when the path is a directory (use `file_list`), and
`file_list` raises when the path is a file (use `file_get`). Reads accept an optional
`ref` (branch, tag, or commit SHA); writes accept an optional `branch` and commit
`message`.

### Issues

| Tool            | Description                                              |
|-----------------|----------------------------------------------------------|
| `issue_get`     | Get a single issue by number                             |
| `issue_list`    | List issues (filter by state, labels, assignee)          |
| `issue_create`  | Create a new issue (title, body, labels, assignees)      |
| `issue_comment` | Post a comment on an issue                               |
| `issue_edit`    | Edit an issue (title, body, state, labels, assignees)    |
| `issue_lock`    | Lock an issue to prevent further comments                |

GitHub's issues endpoint includes pull requests; `issue_list` filters them out, and
`issue_get` raises an error for PR numbers (use `pr_get`).

### Pull requests

| Tool        | Description                                                  |
|-------------|--------------------------------------------------------------|
| `pr_get`    | Get a single pull request by number                          |
| `pr_list`   | List pull requests (filter by state, base branch)            |
| `pr_create` | Create a pull request (title, head, base, body, draft flag)  |

### Reviews

| Tool            | Description                                                       |
|-----------------|-------------------------------------------------------------------|
| `review_create` | Submit a PR review: `APPROVE`, `REQUEST_CHANGES`, or `COMMENT`  |
| `review_list`   | List all reviews on a pull request                                |
| `review_get`    | Get a single review                                               |
| `review_update` | Update the body of a pending review                               |

### Repository

| Tool       | Description                                                            |
|------------|------------------------------------------------------------------------|
| `repo_get` | Repository metadata (stars, forks, language, default branch, etc.)     |

### Releases

| Tool             | Description                                              |
|------------------|----------------------------------------------------------|
| `release_list`   | List releases                                            |
| `release_get`    | Get a single release by ID                               |
| `release_create` | Create a release (tag, title, notes, draft/prerelease)   |
| `release_update` | Update an existing release                               |
| `release_delete` | Delete a release                                         |

### Workflows

| Tool                 | Description                                            |
|----------------------|--------------------------------------------------------|
| `workflow_list`      | List workflows in a repository                         |
| `workflow_get`       | Get a single workflow by ID or filename (e.g. `ci.yml`) |
| `workflow_dispatch`  | Trigger a `workflow_dispatch` event on a branch or tag, with optional inputs |
| `workflow_enable`    | Enable a previously disabled workflow                  |
| `workflow_disable`   | Disable a workflow so it will not run                  |
| `workflow_get_usage` | Billable minutes and run counts for a workflow         |

### Organization & users

| Tool             | Description                                                            |
|------------------|------------------------------------------------------------------------|
| `org_list_repos` | List repos in an organization (filter by type)                         |
| `user_get_repos` | List repos for a user, omit `username` for the authenticated user     |
| `user_invite`    | Invite a user to an organization by email (role: `admin` · `direct_member` · `billing_manager`) |

### Search & commits

| Tool            | Description                                                          |
|-----------------|----------------------------------------------------------------------|
| `search_code`   | Search code, supports GitHub code search syntax (e.g. `mcp_client transport extension:py`) |
| `search_issues` | Search issues and PRs, supports GitHub issue search syntax, optional `state` filter |
| `commit_list`   | List commits, optionally filtered to a file path or starting ref     |
| `commit_get`    | Get a single commit with diff stats and per-file patches             |

---

## Read-only mode

When `readOnly` is `true`, every mutating tool is blocked at dispatch and returns an
error. This is the recommended setting when the agent only needs to inspect repositories.

Blocked tools: `file_create`, `file_edit`, `file_delete`, `issue_create`,
`issue_comment`, `issue_edit`, `issue_lock`, `pr_create`, `review_create`,
`review_update`, `release_create`, `release_update`, `release_delete`,
`workflow_dispatch`, `workflow_enable`, `workflow_disable`, `user_invite`.

Always allowed: `file_get`, `file_list`, `issue_get`, `issue_list`, `pr_get`, `pr_list`,
`review_list`, `review_get`, `repo_get`, `release_list`, `release_get`, `workflow_list`,
`workflow_get`, `workflow_get_usage`, `org_list_repos`, `user_get_repos`, `search_code`,
`search_issues`, `commit_list`, `commit_get`.

Note the default is `false`, a freshly added node can write. Turn read-only mode on
explicitly for inspect-only agents.

---

## Authentication

Set `token` to a GitHub Personal Access Token. Classic tokens need the `repo`, `issues`,
`pull_requests`, and `workflows` scopes; a fine-grained token scoped to only the
repositories the agent needs is the safer choice. The token is sent as a
`Authorization: Bearer` header on every request; there is no unauthenticated mode.

API errors are surfaced to the agent as readable messages including the HTTP status and
GitHub's error details.

Upstream reference: [GitHub REST API documentation](https://docs.github.com/en/rest).

---

## Running the tests

```bash
# Integration tests against a real repository (skipped unless both vars are set)
export GITHUB_TOKEN=<your token>
export GITHUB_TEST_REPO=owner/repo
pytest nodes/test/tool_github/test_tools.py -v
```

---

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- Generated by nodes:docs-generate. Do not edit by hand. -->

## Schema

| Field | Type | Description | Default |
|---|---|---|---|
| `github.defaultRepo` | `string` | **Default Repository**<br/>Default repo in owner/repo format (e.g. acme/myapp). Tool calls that omit the repo parameter will use this value. | `""` |
| `github.readOnly` | `boolean` | **Read-only mode**<br/>When enabled, all write operations (file create/edit/delete, issue create, PR create, etc.) are blocked. Safe for agents that should only read. | `false` |
| `github.token` | `string` | **Personal Access Token**<br/>GitHub PAT with repo, issues, pull_requests, and workflows scopes. Use a fine-grained token scoped to only the repos you need. | `""` |

## Dependencies

- `requests` `>=2.34.2`

## Source

[<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-0.15em;margin-right:0.35em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> View source](https://github.com/rocketride-org/rocketride-server/tree/develop/nodes/src/nodes/tool_github)
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
