---
title: Account Webview Protocol
date: 2026-08-17
sidebar_position: 6
---

# Account webview protocol

The Account page (billing, teams, checkout) is rendered by shared UI
components inside the Account webview; the extension host owns the SDK
connection and every privileged action. The contract lives in
`src/providers/types/accountTypes.ts` (`AccountWebviewToHost` /
`AccountHostToWebview`) — this page documents the surface a webview cannot
perform on its own and therefore delegates to the host.

## Opening a plan action link (`checkout:openAction`)

A checkout plan card can carry an action CTA (for example the "Contact us"
tier links out instead of starting a Stripe checkout). The shared
`CheckoutModal`'s default `onActionClick` calls `window.open`, but a webview
has no browser chrome to satisfy it: the panel navigates to a blank target
with no way back ([#1303](https://github.com/rocketride-org/rocketride-server/issues/1303)).
The webview forwards the request and the host opens it with
`vscode.env.openExternal` instead.

| Direction | Message | Payload | Purpose |
| --- | --- | --- | --- |
| webview to host | `checkout:openAction` | `url` | Open a plan card's action CTA in the user's browser (or mail client for a `mailto` action). |

### `url` payload

The webview builds one string before sending, from the shared `PlanAction`:

- **Link actions** (`action.type === 'link'`): `url` is `action.url` as-is,
  an `http`/`https` URL.
- **Mail actions** (`action.type === 'mailto'`): `url` is a `mailto:` URI,
  `mailto:${action.url}`, with an optional
  `?subject=${encodeURIComponent(action.subject)}` when the action names a
  subject. The subject is percent-encoded so spaces and punctuation survive
  the URI.

### Host scheme allowlist

`handleOpenPlanAction` parses the incoming `url` with `vscode.Uri.parse` and
opens it only when its scheme is one of:

- `http`
- `https`
- `mailto`

Any other scheme is refused and logged, never handed to
`vscode.env.openExternal`. This value originates in the webview and ends at
the OS URL handler, so the allowlist is the trust boundary: unlike the other
`openExternal` calls in `AccountProvider`, which build their URLs host-side,
this one must not forward an arbitrary scheme (`file:`, `command:`, …) to the
operating system.
