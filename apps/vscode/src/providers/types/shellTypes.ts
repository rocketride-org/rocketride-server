// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Shell-level webview protocol — the messages EVERY host/webview pair
 * exchanges, independent of what the view shows: theme delivery, connection
 * state, view lifecycle. Each per-view protocol file (accountTypes.ts,
 * projectTypes.ts, monitorTypes.ts, ...) composes these unions beside its
 * own view-specific messages; no view file redeclares a shell message.
 *
 * Pure types only — this file is imported by both the extension host and
 * the webviews, so it must never import 'vscode' or any tsx module.
 */

/**
 * Shell pushes from the host. `isSubscribed`/`serverHost` ride the
 * connection push only where the host knows them.
 */
export type ShellHostToWebview = { type: 'shell:init'; theme: Record<string, string>; isConnected: boolean } | { type: 'shell:themeChange'; tokens: Record<string, string> } | { type: 'shell:connectionChange'; isConnected: boolean; isSubscribed?: boolean; serverHost?: string } | { type: 'shell:viewActivated'; viewId: string } | { type: 'shell:event'; event: unknown };

/** Shell lifecycle requests every webview can send to its host. */
export type ShellWebviewToHost = { type: 'view:ready' } | { type: 'view:initialized' };
