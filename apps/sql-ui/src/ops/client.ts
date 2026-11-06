// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// SQL OPS — CLIENT side (a FRAME mount calls these on the controller)
// =============================================================================

import { createToolOpClient } from 'shell';
import type { ToolChannel } from 'shell';
import type { SqlEndpoint } from '../connect';
import type { SqlOps } from './types';

/** The frame's typed view of the controller-served lifecycle ops. */
export interface ISqlOpsClient {
	/** Resolve a saved connection to a live endpoint (the controller owns
	 *  direct-mode revival). */
	resolveEndpoint(connId: string): Promise<SqlEndpoint>;
	/** Stop a direct connection's temp pipeline, fire-and-forget (a late or
	 *  lost reply is fine — the idle TTL reaps). */
	releaseEndpoint(key: string): void;
	/** Discover database endpoints in the server's running pipelines. */
	discoverEndpoints(): Promise<SqlEndpoint[]>;
}

/**
 * The client side of the sql tool's ops, for a frame mount.
 *
 * @param channel - The mount's channel.
 * @returns The typed calls.
 */
export function createSqlOpsClient(channel: ToolChannel): ISqlOpsClient {
	const call = createToolOpClient<SqlOps>(channel);
	return {
		resolveEndpoint: (connId) => call('sql.resolveEndpoint', { connId }),
		releaseEndpoint: (key) => {
			void call('sql.releaseEndpoint', { key }).catch(() => undefined);
		},
		discoverEndpoints: () => call('sql.discoverEndpoints', {}),
	};
}
