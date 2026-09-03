---
title: Webview Protocol
sidebar_position: 4
---

## Pipeline Canvas Cloud Setup

The pipeline custom editor exchanges the following Cloud onboarding messages:

| Direction       | Message                             | Purpose                                                                                                  |
| --------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Host to webview | `project:cloudConnectionConfigured` | Updates whether Development or Deployment uses Cloud.                                                    |
| Host to webview | `project:initialPrefs`              | Broadcasts changed global-scoped preferences to other ready project editors. Merge, not replace.          |
| Webview to host | `project:openCloudSetup`            | Opens RocketRide Settings on the Development tab; Cloud remains a user-selected configuration change.   |

`project:load` may include `cloudConnectionConfigured`. The field is optional
for compatibility with hosts that do not implement Cloud onboarding.

Project preference changes have merge semantics, so this update path cannot
delete preference keys. `cloudCanvasPromptDismissed` is stored in global state
while the remaining preferences stay workspace-scoped; `project:load` sends the
two combined as one bag.

Webviews send their whole preference bag, so the host persists only the keys
whose values actually changed. `project:initialPrefs` then carries just the
changed global-scoped keys to the other open editors — workspace preferences
such as layout and navigation mode are per-editor view state and are not
propagated.

## Settings Command

`rocketride.page.settings.open` accepts these positional arguments:

1. An optional focus tab: `development`, `deployment`, `pipeline`, or `integrations`.
2. An optional authentication error message.

The resulting `setFocus` message accepts all four tab IDs and only activates the
matching tab. Opening Settings never preselects or stages a connection mode:
`development.connectionMode` is workspace-global, so a staged change would be
applied on the next Save even if the user only meant to edit something else.
Choosing Cloud stays an explicit user action.
