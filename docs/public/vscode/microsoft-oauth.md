---
title: Microsoft Account Sign-In
sidebar_position: 6
---

# Microsoft account sign-in (node OAuth)

Nodes that talk to Microsoft 365 services (Excel, Word, OneDrive, Outlook
Mail, Outlook Calendar) offer a "Login with Microsoft" button in the node
config panel. Microsoft's consent screen cannot render inside a VS Code
webview, so the extension opens the system browser and receives the
resulting tokens through a deep link.

:::note Broker rollout in progress
The hosted OAuth broker's Microsoft provider and its bounce page are being
built in the cloud repo; this user-OAuth path goes live once they ship. The
[app-only (client credentials)](#app-authentication-client-credentials) path
below works today and does not depend on the broker.
:::

## Flow

1. The webview asks the host to open the hosted OAuth broker URL.
2. The extension opens the system browser at the broker
   (`https://oauth2.rocketride.ai/microsoft?...`), passing the node's service
   config, a `baseURL` return address, and an explicit `scope` parameter for
   the node's selected access tier. Scopes are keyed by the node's provider
   (see `SERVICE_TIER_SCOPES` in `LoginWithMicrosoftButton.tsx`, mirroring
   the per-service `AccessSpec`s in `microsoft_access.py`); an unknown
   provider or tier sends no `scope` parameter. Five services are covered:
   `excel`, `word`, and `onedrive` (`readonly` | `write`), `outlook_mail`
   (`readonly` | `send` | `modify`), and `outlook_calendar`
   (`readonly` | `write`). The broker grants identity
   (`openid email profile`) plus exactly the requested Graph scopes — least
   privilege.
3. The user completes Microsoft Entra's consent screen. The broker exchanges
   the code using its own verified Entra application; no client secret ever
   reaches the extension or the pipeline config.
4. The broker redirects to the bounce page
   (`https://api.rocketride.ai/auth/vscode/microsoft`), which forwards the
   result to the editor deep link
   `vscode://rocketride.rocketride/auth/microsoft`.
5. The extension routes the tokens to the **live** editor for the document
   that started the login (resolved at delivery time — the original webview
   may have been recycled during the browser round-trip). If no live editor
   exists, the tokens are held and redelivered after the next editor load;
   undelivered tokens expire after 5 minutes. After the webview applies the
   tokens, the host saves the document, so the tokens reach the `.pipe` file
   without a manual save.

## Host and webview contract

Messages exchanged between the extension host and the pipeline editor webview:

| Direction | Message | Payload | Purpose |
| --- | --- | --- | --- |
| host to webview | `project:load` | `oauthReturnUrl: string` | The `baseURL` the webview passes to the broker. In VS Code this is the bounce page URL carrying the editor's URI scheme (`?scheme=vscode`, `vscode-insiders`, etc.). Sent on every load; a load also clears any webview-held pending tokens — but the host redelivers undelivered broker tokens right after the load, so a reload during the browser trip does not lose them. |
| webview to host | `project:openExternal` | `url: string` | Ask the host to open the broker URL in the system browser. The host registers a one-shot token waiter keyed by the URL's `node_id` before opening. If the browser fails to open, the waiter is unregistered and an error is shown. |
| host to webview | `project:oauthTokens` | `tokens: string, state: string` | Raw broker result, delivered to the current live webview for the originating document. `state` is JSON echoing the originating `node_id`; the config panel applies tokens only to the matching node, then clears them. The host saves the document after the first `project:contentChanged` that follows a delivery (one-shot), so no manual save is needed. |

The deep link handled by the extension is
`<uriScheme>://rocketride.rocketride/auth/microsoft` with query parameters
`tokens`, `state`, and on failure `oauth_error` / `error` /
`error_description` (see `CloudAuthProvider.handleProviderOAuth`, the shared Google/Microsoft handler).

## Saved config shape

Tokens land at the node config **root**: `authType: "user"` and
`userToken: "<JSON token string>"`. Node configs are flat — the engine reads
`cfg.get('authType')` / `cfg.get('userToken')` at the top level, and the
generated form schema names dotted `services.json` field ids (for example
`microsoft.userToken`) by their last component. The `parameters.*` locations
some widgets also read are legacy and are never written by this flow.

## Scopes and access tiers

The granted scopes are fixed at consent time. Raising a node's access tier
after connecting (for example Outlook Mail `modify` → a tier needing more
scopes) requires disconnecting and reconnecting the Microsoft account so the
new tier's scopes are consented. Lowering the tier does not: the engine's
scope check treats a family's `.ReadWrite` (or `.ReadWrite.All`) scope as
covering the matching `.Read` scope, and any `.All` scope as covering the
same scope without `.All` (`missing_scopes` in `core/microsoft_access.py`).
Tokens without a `scope` field are accepted (fail-open, for older tokens).

The five services and their tiers (see `SERVICE_TIER_SCOPES` in
`LoginWithMicrosoftButton.tsx` and the `AccessSpec`s in
`nodes/src/nodes/core/microsoft_access.py`):

| Service | Tiers | Scopes |
| --- | --- | --- |
| Excel | `readonly`, `write` (default) | `Files.ReadWrite` / `Files.ReadWrite` (Graph's workbook API accepts only delegated `Files.ReadWrite`, reads included; the `readonly` tier is a node-side write gate) |
| Word | `readonly`, `write` (default) | `Files.Read` / `Files.ReadWrite` |
| OneDrive | `readonly`, `write` (default) | `Files.Read` / `Files.ReadWrite` (sign-in also requests `User.ReadBasic.All` for invite recipient lookup; personal accounts cannot grant it, and the invite gate then refuses invites) |
| Outlook Mail | `readonly`, `send`, `modify` (default) | `Mail.Read` / `Mail.Read` + `Mail.Send` / `Mail.ReadWrite` + `Mail.Send` |
| Outlook Calendar | `readonly`, `write` (default) | `Calendars.Read` / `Calendars.ReadWrite` |

## Limitation

Tokens are applied by the node config panel. If the panel is closed when the
deep link returns, the tokens stay pending in the editor until the panel is
reopened for the node that started the login (or until the editor reloads
and the redelivery expires). There is also no disconnect affordance yet —
the login button disables once authenticated; clearing a token currently
means editing the `.pipe` by hand.

## Token refresh

The saved token carries an `oauth_server_url` pointing at the broker's
`/refresh` endpoint. At runtime the engine only honors that URL when it is
`https` and its host is a known broker host; self-hosted deployments can add
their own broker host with the `RR_OAUTH_BROKER_URL` environment variable.

## App authentication (client credentials)

The Word, OneDrive, Outlook Mail, and Outlook Calendar tool nodes also accept
`microsoft.authType: "service"` — an Entra app registration authenticating
with its own client credentials instead of a signed-in user. This path does
not depend on the OAuth broker and works today.

:::caution Excel is user OAuth only
Microsoft Graph's workbook (Excel) API does not support application
permissions — an app-only token is rejected regardless of what the app
registration has been granted. The Excel node therefore needs the
[user sign-in](#flow) path with the delegated `Files.ReadWrite` permission
(its own README documents this). Do not add Excel to the app-only walkthrough
below.
:::

### Entra app registration walkthrough

1. In the **Entra admin center** (`entra.microsoft.com`) go to
   **App registrations** → **New registration**. Register a
   **single-tenant** app (accounts in this organizational directory only).
2. Under **API permissions**, add **Microsoft Graph** →
   **Application permissions** (not delegated) matching each service the
   node will use **and the access tier configured on that node**
   (`<service>.access`). The engine checks the token's granted permissions
   against the tier's required scopes (`missing_scopes` in
   `core/microsoft_access.py`); an `.All` application permission satisfies
   the matching delegated scope name.

   | Service | Tier | Application permission |
   | --- | --- | --- |
   | Word | `readonly` | `Files.Read.All` |
   | Word | `write` (default) | `Files.ReadWrite.All` |
   | OneDrive | `readonly` | `Files.Read.All` |
   | OneDrive | `write` (default) | `Files.ReadWrite.All` |
   | OneDrive | any, when `onedrive.allowPublicSharing` is off and the agent uses `onedrive_invite` | `User.Read.All` (directory lookup of invite recipients; without it the invite fails closed) |
   | Outlook Mail | `readonly` | `Mail.Read` |
   | Outlook Mail | `send` | `Mail.Read` + `Mail.Send` |
   | Outlook Mail | `modify` (default) | `Mail.ReadWrite` + `Mail.Send` |
   | Outlook Calendar | `readonly` | `Calendars.Read` |
   | Outlook Calendar | `write` (default) | `Calendars.ReadWrite` |

   `Mail.Send` is a separate action permission — `Mail.ReadWrite` does not
   imply it, so the `send` and `modify` tiers list both.
3. Click **Grant admin consent for &lt;tenant&gt;** — application permissions
   are tenant-wide and require an admin to consent; the app cannot self-consent.
4. Under **Certificates & secrets**, create a **client secret** and copy its
   value immediately (it is not shown again).
5. Fill in the node config:

   | Field | Value |
   | --- | --- |
   | `microsoft.authType` | `"service"` |
   | `microsoft.tenantId` | the Entra tenant (directory) ID |
   | `microsoft.clientId` | the app registration's application (client) ID |
   | `microsoft.clientSecret` | the client secret value from step 4 |
   | `microsoft.userPrincipalName` | the acting user's UPN (email-shaped sign-in name) |

   Application permissions are not scoped to a mailbox or drive by
   themselves — every Graph call the node makes targets
   `/users/{userPrincipalName}` (mail, calendar) or that user's OneDrive, so
   `userPrincipalName` selects whose data the app-only credentials act on.

### App-only limitations

- **Excel:** not available under app-only auth (see the caution above).
- **OneDrive `onedrive_restore`:** Graph's item restore is OneDrive Personal
  only; the tool refuses up front under app-only auth, which is always a
  work/school tenant. Use the OneDrive web recycle bin instead.
- **Outlook Calendar `outlook_calendar_find_meeting_times`:** Graph's
  `findMeetingTimes` needs a signed-in user context and may not be
  supported under client credentials.

### Narrowing app-only access

`Files.ReadWrite.All`, `Mail.ReadWrite`, and `Calendars.ReadWrite` grant the
app access to every mailbox/calendar/drive in the tenant, not just the
configured `userPrincipalName` — RocketRide does not enforce a narrower
scope itself, only the acting-user convention above. To restrict the app's
reach at the Microsoft 365 side:

- **Mail and calendar:** Exchange Online's
  [`New-ApplicationAccessPolicy`](https://learn.microsoft.com/en-us/powershell/module/exchange/new-applicationaccesspolicy)
  restricts an application permission grant to a mail-enabled security group
  of specific mailboxes, so the app can only act on the users in that group
  even though the Graph permission is tenant-wide.
- **Files (OneDrive/SharePoint):** the sites-selected pattern
  (`Sites.Selected` plus a site-level permission grant) narrows file access
  to specific SharePoint sites rather than every drive in the tenant; the
  bundled OneDrive node currently declares `Files.ReadWrite.All` and does
  not use `Sites.Selected`, so adopting it is a deployment-side choice, not
  something the node configures.

Both mechanisms are configured directly against Microsoft 365 / Entra, not
through RocketRide.
