// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Dev/deploy run classification for stamped task-event bodies — a PURE leaf
 * (no shell import, no DOM) so the VS Code EXTENSION HOST can consume it
 * beside the webview hosts (deep-import this file, never the barrel).
 */

/**
 * Returns true when a stamped task-event body belongs to a DEPLOY run.
 *
 * The bare runKind test (no project filter) — hosts apply it where a feed
 * must exclude deploy traffic wholesale (dev status caches, sidebar dev
 * forwarding) before any per-project classification. The server stamps
 * runKind at its forward choke point; absence means a dev run.
 *
 * @param body - The event body.
 * @returns True for deploy-run bodies.
 */
export function isDeployRunBody(body: unknown): boolean {
	return (body as { runKind?: string } | undefined)?.runKind === 'deploy';
}
