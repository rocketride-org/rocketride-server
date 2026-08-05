// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * OAuth configuration for the shared-ui social-login buttons.
 *
 * User-OAuth (Google/Microsoft/Slack) is brokered by a RocketRide-hosted
 * function — NOT by the local engine. Self-hosters never register their own
 * Google OAuth app or client secret; a single hosted broker owns the verified
 * consent screen, the client secret, and the token-refresh proxy. See the
 * social-button widgets and `useOAuthCallbacks` for the consuming flow.
 *
 * The value is inlined at build time from `REACT_APP_OAUTH_ROOT_URL`: every
 * bundler that consumes shared-ui `define`s it to a string literal (see
 * `rslib.config.ts` and `apps/vscode/rsbuild.config.mjs`), so no `process`
 * reference survives into the webview bundle. An empty/unset value falls back
 * to the production broker URL.
 */
export const OAUTH_ROOT_URL: string = process.env.REACT_APP_OAUTH_ROOT_URL || 'https://oauth2.rocketride.ai';
