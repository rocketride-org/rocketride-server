# tool_jira

A RocketRide tool node that gives an agent access to Jira Cloud: search issues with JQL, read an issue and its comments, list projects, create issues and add comments. Pick it when an agent triages, reports on or files work that lives in Jira.

## About Jira

Jira is Atlassian's issue and project tracker. Work is organized in projects, each with its own issue types (Task, Bug, Story, Epic and so on) and workflow statuses, and is queried with JQL, Jira's query language. Jira Cloud sites live at `https://<site>.atlassian.net`.

## What it does

The node has no data lanes; it exists only as an agent tool server, exposing six Jira operations. An agent typically searches with JQL to find issue keys, reads an issue for its full text, and, when writes are allowed, files a new issue or comments on an existing one. Pick it over a generic HTTP tool when you want basic auth, Jira's document format for text, the current search pagination and a project allowlist handled for you.

Jira v3 stores descriptions and comments in the Atlassian Document Format (ADF), not plain text. The node converts both ways: what an agent writes becomes ADF (blank-line-separated paragraphs, `- ` or `* ` bullet lists and fenced code blocks), and what it reads comes back as plain text.

## As a tool

The server-name prefix is `jira`, producing these registered functions.

| Function | Description |
|---|---|
| `jira_check_connection` | Check that the site, email and API token work, and show which account the node acts as. |
| `jira_search` | Search issues with JQL, a page at a time. |
| `jira_issue_get` | Read one issue, its description as text and, optionally, its latest comments. |
| `jira_projects_list` | List the projects the node can use (key, name, type). |
| `jira_issue_create` | Create an issue. Blocked in read-only mode. |
| `jira_comment_add` | Add a comment to an issue. Blocked in read-only mode. |

Every function returns `success`, plus its own fields on success and `error` on failure. Jira API failures are returned in that envelope rather than raised: a JQL syntax error comes back with Jira's own message so the agent can fix its query, 401 and 403 say to check the token or the project permissions, and 404 means the issue does not exist or the account cannot see it.

`jira_search` requires `jql` and accepts `max_results` (1–100, default from **Results per page**) and `next_page_token`. Each issue carries `key`, `summary`, `status`, `type`, `assignee`, `priority`, `updated` and `url`; `next_page_token` is set while more pages remain, and passing it back returns the next page. `jira_issue_get` requires `key` and accepts `include_comments` (default false) and `max_comments` (default 20, newest first). `jira_issue_create` requires `project`, `issue_type` (a name such as `Task`) and `summary`, and accepts `description`, `labels`, `priority` and `assignee_account_id`; it returns `key` and `url`. `jira_comment_add` requires `key` and `body` and returns `comment_id` and `url`.

## Configuration

### Site URL

Your Jira Cloud site, such as `https://your-site.atlassian.net`. Only an `https://<site>.atlassian.net` address with no port or path is accepted, so the token is never sent anywhere else.

### Account email and API token

The Atlassian account the node acts as, and an API token of that account. The token is stored encrypted and masked in the UI. Each of the three connection fields falls back to `ROCKETRIDE_JIRA_SITE_URL`, `ROCKETRIDE_JIRA_EMAIL` and `ROCKETRIDE_JIRA_API_TOKEN` on the engine host; a config value wins over its variable, and startup fails when any of the three is missing.

### Read-only mode

On by default. While on, `jira_issue_create` and `jira_comment_add` refuse with a message that names this setting. Turn it off to allow writes.

### Project allowlist

Comma-separated project keys, such as `PROJ,OPS`. When set, searches are limited to those projects (`project in (...) AND (<your JQL>)`, with any `ORDER BY` kept last), issues and comments are read or written only when the issue's current project is listed, and the project list shows only those projects. The check reads the issue's project rather than trusting its key, because an issue moved between projects keeps resolving under its old key. A search that returns an issue from outside the list fails instead of returning it. Empty means every project the account can see.

### Results per page and label for created issues

**Results per page** is the default page size of a search (1–100, default 25). **Label for created issues**, when set, is added to every issue the node creates.

## Authentication

Create an API token at <https://id.atlassian.com/manage-profile/security/api-tokens> with **Create API token**, not the scoped variant: scoped tokens only work through Atlassian's `api.atlassian.com` gateway, which this node does not use. The node sends the account email and token as HTTP basic auth to `https://<site>.atlassian.net/rest/api/3`. The Jira Cloud Free plan accepts these tokens. The node can do only what that account can do in Jira.

## Notes

### Retries and duplicate writes

Calls time out after 30 seconds. Reads, the search included, retry a 429 up to twice, waiting out Jira's `Retry-After` (up to 30 seconds; a longer wait is reported instead), and retry a 5xx or connection error once. The two writes are never retried, since a write whose outcome is unknown could otherwise create a second issue or comment; an agent that sees a connection error on a write should search before trying again.

### Search pagination

The node uses Jira's current search endpoint, `POST /rest/api/3/search/jql`. It returns no total count, and the node always asks for the fields it returns, because the endpoint otherwise answers with issue ids only.

### Limits

A description or comment over 32,767 bytes is refused before it is sent. A JQL query with unbalanced quotes or parentheses is refused when an allowlist is set, since an extra `)` could otherwise close the allowlist clause.

## Upstream docs

- [Jira Cloud REST API v3](https://developer.atlassian.com/cloud/jira/platform/rest/v3/)
- [Atlassian Document Format](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/)
- [Manage API tokens](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/)

<!-- ROCKETRIDE:GENERATED:PARAMS START -->
<!-- ROCKETRIDE:GENERATED:PARAMS END -->
