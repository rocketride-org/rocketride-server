---
description: Suggest reviewers for pull requests based on changed files and module ownership
on:
  pull_request:
    types: [opened, ready_for_review]
  workflow_dispatch:

engine: copilot

permissions:
  contents: read
  pull-requests: read

tools:
  github:
    toolsets: [pull_requests, repos]

safe-outputs:
  add-reviewer:
    max: 2
  add-comment:
    max: 1
---

# PR Reviewer Suggestion

When a pull request is opened or marked ready for review, analyze the changed files and suggest appropriate reviewers.

## Instructions

1. Skip if the PR author is a bot (login ending in `[bot]`), the PR is a draft, or the PR already has reviewers assigned. If so, call `noop` and stop.

2. Get the list of changed files in the pull request. If there are no changed files, call `noop` and stop.

3. Map each changed file to a module using these path patterns:

   | Module | Paths |
   |--------|-------|
   | `engine` | `packages/server/**`, `apps/engine/**`, `packages/tika/**`, `packages/vcpkg/**` |
   | `sdk-typescript` | `packages/client-typescript/**` |
   | `sdk-python` | `packages/client-python/**`, `packages/client-mcp/**` |
   | `nodes` | `nodes/**` |
   | `ai` | `packages/ai/**` |
   | `chat-ui` | `apps/chat-ui/**`, `apps/dropper-ui/**`, `packages/shared-ui/**` |
   | `vscode` | `apps/vscode/**` |
   | `infra` | `.github/**`, `scripts/**`, `builder`, `builder.js`, `package.json`, `pnpm-lock.yaml`, `CMakeLists.txt` |
   | `docs` | `docs/**`, `*.md`, `apps/vscode/docs/**` |

4. For each detected module, look up reviewers from this ownership table:

   | Module | Primary Reviewer | Secondary Reviewer |
   |--------|-----------------|-------------------|
   | `engine` | `Rod-Christensen` | `stepmikhaylov` |
   | `sdk-typescript` | `dsapandora` | `Rod-Christensen` |
   | `sdk-python` | `Rod-Christensen` | `stepmikhaylov` |
   | `nodes` | `dsapandora` | `ryan-t-christensen` |
   | `ai` | `stepmikhaylov` | `Rod-Christensen` |
   | `chat-ui` | `stepmikhaylov` | `ryan-t-christensen` |
   | `vscode` | `Rod-Christensen` | `stepmikhaylov` |
   | `infra` | `stepmikhaylov` | `Rod-Christensen` |
   | `docs` | `Rod-Christensen` | `stepmikhaylov` |

   If no module matches, use the fallback reviewer: `Rod-Christensen`.
   If the only eligible reviewer is the PR author (both primary, secondary, and fallback are the author), call `noop` and post a comment asking the author to manually select a reviewer.

5. Select 1-2 reviewers following these rules:
   - **Never suggest the PR author as a reviewer.** If the primary reviewer is the PR author, use the secondary reviewer instead.
   - Prefer primary reviewers. Add a secondary reviewer only if the PR touches multiple modules or the primary is the author.
   - Deduplicate: if the same person is primary for multiple modules, count them once.
   - Maximum 2 reviewers total.

6. Request the selected reviewers on the pull request.

7. Post a single comment explaining the suggestion:

   ```
   **Reviewer Suggestion**

   | Module | Suggested Reviewer |
   |--------|--------------------|
   | {module} | @{reviewer} |

   Based on file ownership for the changed paths in this PR.

   _Automated suggestion — feel free to add or change reviewers._
   ```
