---
title: GitHub
date: 2026-04-08
sidebar_position: 1
---

<head>
  <title>GitHub - RocketRide Documentation</title>
</head>

## What it does

Gives agents full access to the GitHub REST API — files, issues, pull requests, reviews, releases, workflows, search, and more. Useful for agents that manage codebases, triage issues, automate releases, or operate CI/CD pipelines.

## Tools

| Group         | Tool                        | Description                          |
| ------------- | --------------------------- | ------------------------------------ |
| Files         | `github.file_get`           | Get a file's content and metadata    |
|               | `github.file_list`          | List files and directories at a path |
|               | `github.file_create`        | Create a new file                    |
|               | `github.file_edit`          | Update an existing file              |
|               | `github.file_delete`        | Delete a file                        |
| Issues        | `github.issue_get`          | Get a single issue                   |
|               | `github.issue_list`         | List issues                          |
|               | `github.issue_create`       | Create a new issue                   |
|               | `github.issue_comment`      | Post a comment on an issue           |
|               | `github.issue_edit`         | Edit an issue                        |
|               | `github.issue_lock`         | Lock an issue                        |
| Pull Requests | `github.pr_get`             | Get a single pull request            |
|               | `github.pr_list`            | List pull requests                   |
|               | `github.pr_create`          | Create a pull request                |
| Reviews       | `github.review_create`      | Submit a PR review                   |
|               | `github.review_list`        | List reviews on a PR                 |
|               | `github.review_get`         | Get a single review                  |
|               | `github.review_update`      | Update a pending review              |
| Repository    | `github.repo_get`           | Get repository metadata              |
| Releases      | `github.release_list`       | List releases                        |
|               | `github.release_get`        | Get a single release                 |
|               | `github.release_create`     | Create a release                     |
|               | `github.release_update`     | Update a release                     |
|               | `github.release_delete`     | Delete a release                     |
| Workflows     | `github.workflow_list`      | List workflows                       |
|               | `github.workflow_get`       | Get a single workflow                |
|               | `github.workflow_dispatch`  | Trigger a workflow manually          |
|               | `github.workflow_enable`    | Enable a workflow                    |
|               | `github.workflow_disable`   | Disable a workflow                   |
|               | `github.workflow_get_usage` | Get workflow usage/billing stats     |
| Organization  | `github.org_list_repos`     | List repos in an organization        |
| Users         | `github.user_get_repos`     | List repos for a user                |
|               | `github.user_invite`        | Invite a user to an organization     |
| Search        | `github.search_code`        | Search code across repos             |
|               | `github.search_issues`      | Search issues and PRs                |
| Commits       | `github.commit_list`        | List commits                         |
|               | `github.commit_get`         | Get a commit with diff stats         |

Most tools accept an optional `repo` parameter (`owner/repo`). If omitted, the configured default repo is used.

## Configuration

| Field        | Description                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------- |
| Token        | GitHub Personal Access Token — requires `repo`, `issues`, `pull_requests`, and `workflows` scopes |
| Default Repo | Fallback repo used when `repo` is not passed to a tool (`owner/repo` format)                      |
| Read Only    | Block all write operations — prevents file edits, issue creation, PR creation, releases, etc.     |

## Upstream docs

- [GitHub REST API documentation](https://docs.github.com/en/rest)
