# RocketRide Product Telemetry — What We Collect

We use [PostHog](https://posthog.com) (Cloud, US) to understand how RocketRide apps
are used so we can improve the product — e.g. see which nodes people run and invest
accordingly. This documents **exactly** what is and isn't collected (per the
2026-07-01 telemetry review).

The reporting logic is shared: it lives in the `rocketride` client
(`packages/client-typescript/src/client/telemetry.ts`) so the **web shell** and the
**VS Code extension** send events through the exact same path. This file documents
the shell's use of it; keep the two in sync.

## What we collect
- **Events** — explicit `report()` calls only. Product actions such as:
  - `pipeline:run` — a pipeline/canvas was run (the headline event).
  - `pipeline:node_add` / `pipeline:node_remove`, `app:open`, `auth:sign_in`.
- **Structural metadata** on those events:
  - `node_types` — the **types** of nodes/providers used in a run (e.g. `llm_anthropic`,
    `http_request`), so we can see which nodes are popular. **Not** their configuration.
  - `node_count`, `duration_ms`, `status`, `surface` (`home_ui` / `vscode`).
- **App context** (attached to every event): `app_id`, `app_name`, `app_version`.
- **User identity**: a per-browser random `distinct_id`; once signed in, a stable
  user id from our IdP and, minimally, `org_id`.

## What we do NOT collect
- ❌ Pipeline configuration, node inputs/outputs, prompts, or any user content.
- ❌ Files or data flowing through pipelines; credentials, API keys, tokens.
- ❌ **No autocapture and no session replay** — the transport only ever sends the
  explicit events above (there is nothing that scrapes the DOM or records the screen).
- A `sanitize()` step drops known PII / content property keys before send, as a
  backstop even if one is passed by mistake.

## Opt-out
- **Web shell**: `optOut()` / `optIn()` persist the choice per browser; when opted
  out, nothing is sent.
- **VS Code**: the extension wires the shared telemetry's `enabled` gate to
  `vscode.env.isTelemetryEnabled`, so it follows the editor's telemetry setting.

## Ingestion
Events are a direct HTTPS `POST` to `https://e.rocketride.ai/i/v0/e/` — a CloudFront
reverse proxy to PostHog Cloud (terraform `management/posthog-proxy.tf`) — so they're
first-party (ad-blocker-resistant) and no third-party analytics domain is exposed.
The public project key (`phc_…`) is injected at build time via
`ROCKETRIDE_POSTHOG_KEY`; unset (OSS/local) → telemetry is disabled.
