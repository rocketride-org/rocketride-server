---
description: Automatically triage new issues with type, priority, and module labels
on:
  issues:
    types: [opened, reopened]
  workflow_dispatch:

engine: copilot

permissions:
  contents: read
  issues: read

tools:
  github:
    toolsets: [issues, labels, projects]

safe-outputs:
  add-labels:
    max: 6
  add-comment:
    max: 1
  update-project:
    project: "https://github.com/orgs/rocketride-org/projects/5"
    github-token: ${{ secrets.GH_AW_PROJECT_GITHUB_TOKEN }}
    max: 1
---

# Auto-Triage

When a new issue is opened or reopened, analyze it and apply the correct labels.

## Instructions

1. Read the issue title, body, and any template fields (severity dropdown, module checkboxes, etc.).

2. Skip issues created by bots (author login ending in `[bot]`), or issues that already have the `auto-triage` label (already triaged). If skipping, call `noop` and stop.

3. Apply exactly **one type label** based on the issue content:
   - `bug` — something is broken or behaving incorrectly
   - `feature` — a new capability or enhancement request
   - `infra` — CI/CD, build system, deployment, or infrastructure
   - `docs` — documentation improvements or corrections
   - `chore` — maintenance, refactoring, dependency updates

4. Apply exactly **one priority label** based on the severity dropdown (if present) or inferred from the issue content:
   - `P0-critical` — service down, data loss, security vulnerability
   - `P1-high` — major feature broken, no workaround
   - `P2-medium` — feature impaired, workaround exists
   - `P3-low` — minor inconvenience, cosmetic issue

   If the issue uses the Bug Report template, map the severity dropdown directly:
   - "P0 - Critical (service down, data loss)" → `P0-critical`
   - "P1 - High (major feature broken, no workaround)" → `P1-high`
   - "P2 - Medium (feature impaired, workaround exists)" → `P2-medium`
   - "P3 - Low (minor inconvenience)" → `P3-low`

   For feature requests or issues without a severity field, default to `P2-medium` unless the content clearly indicates higher or lower priority.

5. Apply **1-2 module labels** based on paths, keywords, or the "Affected Modules" checklist in the template:

   | Label | Paths / Keywords |
   |-------|-----------------|
   | `engine` | `packages/server/**`, `apps/engine/**`, `packages/tika/**`, `packages/vcpkg/**`, C++ engine, core server, Tika, document extraction |
   | `sdk-typescript` | `packages/client-typescript/**`, TypeScript SDK, JS client |
   | `sdk-python` | `packages/client-python/**`, `packages/client-mcp/**`, Python SDK, MCP |
   | `nodes` | `nodes/**`, pipeline nodes, data processing nodes |
   | `ai` | `packages/ai/**`, AI modules, embeddings, LLM |
   | `chat-ui` | `apps/chat-ui/**`, `apps/dropper-ui/**`, `packages/shared-ui/**`, chat interface, UI |
   | `vscode` | `apps/vscode/**`, VS Code extension, editor |

   Map the "Affected Modules" checkboxes from the Feature Request template:
   - "server (C++ engine)" → `engine`
   - "client-typescript" → `sdk-typescript`
   - "client-python" or "client-mcp" → `sdk-python`
   - "nodes (pipeline)" → `nodes`
   - "ai" → `ai`
   - "chat-ui" or "dropper-ui" → `chat-ui`
   - "vscode" → `vscode`
   - "tika" → `engine`

   If no module can be determined, do not apply a module label.

6. Apply the `auto-triage` label to mark that this issue has been automatically triaged.

7. Add the issue to the **OSS Roadmap** project board (organization project #5).

8. Post a single triage summary comment in this format:

   ```
   **Auto-Triage Summary**

   | Field | Value |
   |-------|-------|
   | Type | `{type_label}` |
   | Priority | `{priority_label}` |
   | Module(s) | `{module_labels}` |

   _This issue was automatically triaged. Maintainers: adjust labels if needed._
   ```

## Important Rules

- Only use labels from the taxonomy above. Never invent new labels.
- Apply exactly 1 type label and exactly 1 priority label. Apply 1-2 module labels if determinable.
- Do not remove any labels that were already on the issue (e.g., `bug` or `feature` from templates).
- If the issue already has a type label from the template (e.g., Bug Report adds `bug`), do not add a conflicting type label.
