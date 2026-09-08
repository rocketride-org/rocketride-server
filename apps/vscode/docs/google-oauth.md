---
title: Google Account Sign-In
sidebar_position: 4
---

# Google account sign-in (node OAuth)

Nodes that talk to Google services (for example the Gmail tool) offer a
"Login with Google" button in the node config panel. Google's consent screen
cannot render inside a VS Code webview, so the extension opens the system
browser and receives the resulting tokens through a deep link.

## Flow

1. The webview asks the host to open the hosted OAuth broker URL.
2. The extension opens the system browser at the broker
   (`https://oauth2.rocketride.ai/google?...`), passing the node's service
   config, a `baseURL` return address, and an explicit `scope` parameter for
   the node's selected access tier. Scopes are keyed by the node's provider
   (see `SERVICE_TIER_SCOPES` in `LoginWithGoogleButton.tsx`, mirroring the
   per-service `AccessSpec`s in `google_access.py`); an unknown provider or
   tier sends no `scope` parameter. The broker grants identity
   (`openid email profile`) plus exactly the requested scopes — least
   privilege — validated against an allowlist (unknown scopes are rejected
   with `400 invalid_scope`). Requests without a `scope` parameter fall back
   to the broker's legacy default consent (identity + Drive), which never
   includes Gmail.
3. The user completes Google's consent screen. The broker exchanges the code
   using its own verified Google application; no client secret ever reaches
   the extension or the pipeline config.
4. The broker redirects to the bounce page
   (`https://api.rocketride.ai/auth/vscode/google`), which forwards the result
   to the editor deep link `vscode://rocketride.rocketride/auth/google`.
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
`<uriScheme>://rocketride.rocketride/auth/google` with query parameters
`tokens`, `state`, and on failure `oauth_error` / `error` /
`error_description` (see `CloudAuthProvider.handleProviderOAuth`, the shared Google/Microsoft handler).

## Saved config shape

Tokens land at the node config **root**: `authType: "user"` and
`userToken: "<JSON token string>"`. Node configs are flat — the engine reads
`cfg.get('authType')` / `cfg.get('userToken')` at the top level, and the
generated form schema names dotted `services.json` field ids (for example
`google.userToken`) by their last component. The `parameters.*` locations some
widgets also read are legacy and are never written by this flow.

## Scopes and access tiers

The granted scopes are fixed at consent time. Raising a node's access tier
after connecting (for example `modify` → `send`) requires disconnecting and
reconnecting the Google account so the new tier's scopes are consented.
Lowering the tier does not: the engine's scope check treats
`https://mail.google.com/` as covering every Gmail scope and `gmail.modify`
as covering `gmail.readonly` (`missing_scopes` in `core/google_access.py`).
Tokens without a `scope` field are accepted (fail-open, for older tokens).

## Limitation

Tokens are applied by the node config panel. If the panel is closed when the
deep link returns, the tokens stay pending in the editor until the panel is
reopened for the node that started the login (or until the editor reloads and
the redelivery expires). There is also no disconnect affordance yet — the
login button disables once authenticated; clearing a token currently means
editing the `.pipe` by hand.

## Token refresh

The saved token carries an `oauth_server_url` pointing at the broker's
`/refresh` endpoint. At runtime the engine only honors that URL when it is
`https` and its host is a known broker host; self-hosted deployments can add
their own broker host with the `RR_OAUTH_BROKER_URL` environment variable.
