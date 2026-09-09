---
title: Cloud Sign-In
sidebar_position: 5
---

# Cloud sign-in (Zitadel OIDC)

Signing in to RocketRide Cloud from the extension runs an OIDC authorization
code flow with PKCE against Zitadel. The extension opens the system browser and
receives the result through a deep link back into your editor.

## Which application the extension signs in as

Zitadel identifies the caller by a **client id**, and that id names a specific
application registration. The extension has its own registration, separate from
the one the website uses, because the two need different things:

| | extension | website |
|---|---|---|
| application type | native | web |
| redirect | `vscode://rocketride.rocketride/auth/callback` | `https://<host>` |

The redirect is the reason they cannot share. The extension's callback uses your
editor's URI scheme, and only the native registration lists those. A web
registration does not, so an authorization request that mixes the two is
rejected before any browser window opens:

```json
{"error":"invalid_request",
 "error_description":"The requested redirect_uri is missing in the client configuration."}
```

The scheme is your editor's, not literally `vscode` — `vscode-insiders`,
`cursor`, `windsurf`, `trae` and others each get their own, and all are
registered.

## Where the client id comes from

`RR_ZITADEL_VSCODE_CLIENT_ID` is inlined into the extension at build time by
`apps/vscode/esbuild.js`, which fails the build outright if it is missing. That
baked value is the default and needs no configuration.

## Overriding the tenant

`ioControl('signin', …)` accepts `zitadelUrl` and `clientId`. **They are a
pair.** Supply both to sign in against a different Zitadel tenant, or neither to
use the built-in values.

Supplying only `zitadelUrl` is rejected with an error rather than attempted. A
client id is a registration *inside* a tenant, so the built-in id means nothing
against a different one — the request would reach the new tenant carrying an id
it has never heard of, and fail with the same message as above. Rejecting it
early gives a reason instead of a puzzle.

The mirror case is **not** symmetric, and the asymmetry is deliberate. Supplying
only `clientId` is not rejected — it is **ignored**, and sign-in proceeds with
both built-in values. A client id names a registration inside a tenant, so an id
with no tenant to read it against has nothing to select; discarding it is what
makes the extension reach its own native registration instead of whatever the
caller happened to hold. That is precisely the bug this contract exists to
prevent, so the lone id is dropped on purpose rather than honoured.

It is dropped silently, though. If you pass a `clientId` and sign in as an
application you did not name, that is why.

```ts
// both — sign in against another tenant
ioControl(mode, 'signin', { zitadelUrl: 'https://auth.example.com',
                            clientId:   '123456789012345678' });

// neither — the normal case
ioControl(mode, 'signin');

// zitadelUrl alone — rejected, with an explanation
ioControl(mode, 'signin', { zitadelUrl: 'https://auth.example.com' });
```

## If sign-in fails

**Nothing happens when you click sign in.** The authorization request was
rejected before the browser opened. Check the client id in the URL if you can
see it — a mismatch between the application it names and the redirect the
extension sends is the usual cause.

**The browser opens and returns an error page.** Read the
`error_description`. `redirect_uri is missing in the client configuration`
means the registration you reached does not list your editor's scheme.

**Sign-in reports success but you are still signed out.** Report it. That
combination should not be reachable, and it hides its own cause.
