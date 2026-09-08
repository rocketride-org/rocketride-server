---
title: Deployment Webview Protocol
date: 2026-07-31
sidebar_position: 5
---

# Deployment webview protocol

The deploy surfaces (the file view's DEPLOY page and the team-deployment
record drawer) are rendered by shared UI components inside the Project
webview; the extension host owns the SDK connection and does ALL
SDK-to-view-model mapping before anything crosses `postMessage`. The
contract lives in `src/providers/types/deployTypes.ts` — this page mirrors
its exported surface.

Conventions shared by both protocols:

- **View-model DTOs** (`DeployTeamRefDTO`, `DeployVersionCardDTO`,
  `TeamDeploymentRowDTO`, `TeamDeploymentScheduleDTO`,
  `DeployHistoryRowDTO`, `DeployScheduleRowDTO`, `DeploymentInfoDTO`,
  `SchedulePreviewResultDTO`) mirror
  `apps/shared/src/components/deploy-panel/types.ts` — the contract
  of record — field-for-field, so the webview hands them to the shared
  `DeployPanel` / `DeploymentView` components unchanged.
- **Two correlation styles**: MUTATION and RPC-style requests
  (`deploy:artifact`/`deploy:publish`/`deploy:deploy`, every
  `deployment:*` mutation, `deployment:preview`, `deployment:validate`)
  carry a `requestId`, and their `…Result` reply echoes it with an
  optional `error` string — nothing else rides those replies. FETCH
  messages (`deploy:fetch`, `deployment:fetch`) carry NO `requestId`:
  their answer is a scoped push (`deploy:data`; `deployment:load` /
  `deployment:error` stamped with `teamId` + optional `sourceId`) that
  the host also re-sends after mutations, so it cannot be
  request-correlated by design.
- **Push-driven refresh**: nothing on these surfaces polls. The host relays
  `apaevt_deploy` invalidation events and live `apaevt_task` folds; the
  WEBVIEW then drives its own re-fetch.

## Deploy lifecycle (the file view's DEPLOY page)

`DeployLifecycleWebviewToHost` / `DeployLifecycleHostToWebview`:

| Direction | Message | Payload | Purpose |
| --- | --- | --- | --- |
| webview to host | `deploy:fetch` | `projectId` | Request the lifecycle snapshot for this project. |
| host to webview | `deploy:data` | `versions`, `deployments`, `teams` | The full snapshot: registry versions (newest first), this project's team deployments (the where-live rows), and the caller-visible teams with control rights. Pushed on fetch and after mutations. |
| webview to host | `deploy:artifact` | `requestId`, `projectId`, `version` | Fetch one immutable artifact's pipeline for the version cards' readonly-canvas record drawer. |
| host to webview | `deploy:artifactResult` | `requestId`, `pipeline?`, `error?` | The sha-verified pipeline JSON, or the failure reason. |
| webview to host | `deploy:publish` | `requestId`, `comment`, `deployTo?` | Publish the SAVED document as the next registry version (`deployTo` = one-step publish+deploy). |
| webview to host | `deploy:deploy` | `requestId`, `projectId`, `version`, `teamId` | Point a team at a version — promotion and rollback alike. |
| host to webview | `deploy:actionResult` | `requestId`, `error?` | Completion ack for publish/deploy requests. |

## Deployment record drawer (rides the Project webview channel)

The drawer lives INSIDE the Project webview, so every webview-to-host
message carries the TEAM identity (the project identity is the panel's
own). The scoped pushes (`deployment:load`, `deployment:error`) stamp it
back so a switched drawer ignores stale ones; the requestId-correlated
replies (`deployment:actionResult`, `deployment:previewResult`,
`deployment:validateResult`) and `shell:connectionChange` carry no
`teamId` — correlation or broadcast semantics make it unnecessary.

`DeploymentWebviewToHost` / `DeploymentHostToWebview`:

| Direction | Message | Payload | Purpose |
| --- | --- | --- | --- |
| webview to host | `deployment:fetch` | `teamId`, `sourceId?` | (Re-)fetch the deployment snapshot — on drawer open, on an `apaevt_deploy` invalidation, and after every mutation. `sourceId` absent = the TEAM record. |
| host to webview | `deployment:load` | `teamId` + `DeploymentLoadPayload` | The full host-mapped state of one team deployment: header info, the immutable artifact pipeline (readonly DESIGN), per-source schedule rows, versions, history, next-run previews, `runningSources`, and the caller's control rights. |
| host to webview | `deployment:error` | `teamId`, `sourceId?`, `error` | The record could not be loaded; the record guard (`teamId` + `sourceId`) drops errors from a stale fetch after switching records. |
| webview to host | `deployment:setDisabled` | `teamId`, `requestId`, `disabled` | The whole-deployment kill switch. |
| webview to host | `deployment:deployVersion` | `teamId`, `requestId`, `version` | Point this team at a version (Deploy version… / Rollback alike). |
| webview to host | `deployment:remove` | `teamId`, `requestId` | Soft-remove the deployment (history and artifacts survive). |
| webview to host | `deployment:runSource` | `teamId`, `requestId`, `sourceId` | Start one source NOW (the manual smoke-test dispatch). |
| webview to host | `deployment:stopSource` | `teamId`, `requestId`, `sourceId` | Stop one source's live run. |
| webview to host | `deployment:setSourceConfig` | `teamId`, `requestId`, `sourceId`, `traceLevel`, `debugOut` | Persist one source's execution settings. |
| webview to host | `deployment:setSchedulePaused` | `teamId`, `requestId`, `sourceId`, `paused` | Pause/resume one source's schedule — cron/ttl preserved. |
| webview to host | `deployment:setSchedule` | `teamId`, `requestId`, `sourceId`, `cron`, `ttl?` | Set (cron string) or clear (`null`) one source's schedule. |
| host to webview | `deployment:actionResult` | `requestId`, `error?` | Completion ack for any `deployment:*` mutation. |
| webview to host | `deployment:preview` | `teamId`, `requestId`, `cron`, `count` | Cron preview via the server's single evaluator — clients never parse cron. |
| host to webview | `deployment:previewResult` | `requestId`, `result`, `error?` | Validity + next occurrences. |
| webview to host | `deployment:validate` | `teamId`, `requestId`, `pipeline` | Pipeline validation passthrough for the readonly canvas. |
| host to webview | `deployment:validateResult` | `requestId`, `result` | Validation errors/warnings. |
| host to webview | `shell:connectionChange` | `isConnected` | Deploy-connection state for the drawer's connection indicator. |
