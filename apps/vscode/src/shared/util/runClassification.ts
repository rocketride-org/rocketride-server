// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Host-side dev/deploy run classification for stamped task-event bodies.
 *
 * The extension HOST bundle has no `shared` alias, so it cannot import
 * shared's `isDevLiveEvent` — this predicate is the host's single copy of
 * the same runKind test, used by ProjectProvider (status cache) and
 * SidebarProvider (dev status forwarding) so the two cannot drift.
 */

/**
 * Returns true when a stamped task-event body belongs to a DEPLOY run.
 *
 * Deploy-run events reach the deploy surfaces through team-scoped sessions;
 * they must never enter the dev caches or the sidebar's dev status feed.
 *
 * @param body - The event body (the server stamps runKind at its forward
 *   choke point; absence means a dev run).
 * @returns True for deploy-run bodies.
 */
export function isDeployRunBody(body: unknown): boolean {
	return (body as { runKind?: string } | undefined)?.runKind === 'deploy';
}
