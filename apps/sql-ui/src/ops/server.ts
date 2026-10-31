// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// SQL OPS — SERVER side (the tool's sidebar CONTROLLER serves these)
// =============================================================================
//
// ENDPOINT LIFECYCLE only — direct-mode temp pipelines are refcounted, and
// the refcount must have a single owner realm. Statement traffic never
// arrives here: frames run it on their own realm client (sqlEnv.ts).
// =============================================================================

import { ConnectionManager, createToolOpServer } from 'shell';
import type { ToolChannel } from 'shell';
import type { RocketRideClient } from 'rocketride';
import { discoverSqlEndpoints, getSavedConnection, releaseDirectEndpoint, resolveEndpoint } from '../connect';
import type { SqlOps } from './types';

/** The realm's connected client, or throws the standard message. */
function needRealmClient(): RocketRideClient {
	const cm = ConnectionManager.getInstance();
	const client = cm.getClient();
	if (!client || !cm.isConnected()) throw new Error('Not connected to a server.');
	return client;
}

/**
 * Serves the sql tool's ops on the controller mount.
 *
 * @param channel - The mount's channel.
 * @returns Dispose.
 */
export function serveSqlOps(channel: ToolChannel): () => void {
	const ops = createToolOpServer<SqlOps>(channel);
	ops.serve('sql.resolveEndpoint', async ({ connId }) => {
		const conn = getSavedConnection(connId);
		if (!conn) throw new Error(`No saved connection '${connId}'.`);
		return resolveEndpoint(needRealmClient(), conn);
	});
	ops.serve('sql.releaseEndpoint', async ({ key }) => {
		await releaseDirectEndpoint(needRealmClient(), key);
	});
	ops.serve('sql.discoverEndpoints', async () => discoverSqlEndpoints(needRealmClient()));
	return () => ops.dispose();
}
