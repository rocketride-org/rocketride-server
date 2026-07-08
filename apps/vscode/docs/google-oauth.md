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
   config and a `baseURL` return address.
3. The user completes Google's consent screen. The broker exchanges the code
   using its own verified Google application; no client secret ever reaches
   the extension or the pipeline config.
4. The broker redirects to the bounce page
   (`https://api.rocketride.ai/auth/vscode/google`), which forwards the result
   to the editor deep link `vscode://rocketride.rocketride/auth/google`.
5. The extension routes the tokens back to the node that started the login and
   saves them into the node's configuration.

## Host and webview contract

Messages exchanged between the extension host and the pipeline editor webview:

| Direction | Message | Payload | Purpose |
| --- | --- | --- | --- |
| host to webview | `project:load` | `oauthReturnUrl: string` | The `baseURL` the webview passes to the broker. In VS Code this is the bounce page URL carrying the editor's URI scheme (`?scheme=vscode`, `vscode-insiders`, etc.). Sent on every load; a load also clears any pending tokens. |
| webview to host | `project:openExternal` | `url: string` | Ask the host to open the broker URL in the system browser. The host registers a one-shot token waiter keyed by the URL's `node_id` before opening. If the browser fails to open, the waiter is unregistered and an error is shown. |
| host to webview | `project:oauthTokens` | `tokens: string, state: string` | Raw broker result delivered after the deep link returns. `state` is JSON echoing the originating `node_id`; the config panel applies tokens only to the matching node, then clears them. |

The deep link handled by the extension is
`<uriScheme>://rocketride.rocketride/auth/google` with query parameters
`tokens`, `state`, and on failure `oauth_error` / `error` /
`error_description` (see `CloudAuthProvider.handleGoogleOAuth`).

## Token refresh

The saved token carries an `oauth_server_url` pointing at the broker's
`/refresh` endpoint. At runtime the engine only honors that URL when it is
`https` and its host is a known broker host; self-hosted deployments can add
their own broker host with the `RR_OAUTH_BROKER_URL` environment variable.
