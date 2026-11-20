// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// MONITOR OPS — CLIENT side (a FRAME mount calls these on the controller)
// =============================================================================

import { createToolOpClient } from 'shell';
import type { ToolChannel } from 'shell';
import type { MonitorOps } from './types';

/** The frame's typed view of the controller-served ops. */
export interface IMonitorOpsClient {
	/** Manual dashboard refresh — nudges the controller's shared poller.
	 *  Never rejects: a lost nudge is answered by the next poll tick. */
	refresh(): Promise<void>;
}

/**
 * The client side of the monitor's ops, for a frame mount.
 *
 * @param channel - The mount's channel.
 * @returns The typed calls.
 */
export function createMonitorOpsClient(channel: ToolChannel): IMonitorOpsClient {
	const call = createToolOpClient<MonitorOps>(channel);
	return {
		refresh: () => call('monitor.refresh', {}).then(() => undefined, () => undefined),
	};
}
