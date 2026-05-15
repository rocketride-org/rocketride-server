// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// USE CONNECTION STATUS — reactive ConnectionStatus from the ConnectionManager
// =============================================================================

import { useState, useEffect } from 'react';
import type { ConnectionStatus } from 'shared';
import { ConnectionState } from 'shared';
import { ConnectionManager } from '../connection/connection';

/**
 * Returns the current ConnectionStatus with automatic re-renders on changes.
 *
 * Subscribes to `shell:statusChange` events and returns the full
 * ConnectionStatus object (state, connectionMode, retryAttempt, etc.).
 *
 * @returns The current ConnectionStatus.
 *
 * @example
 * ```tsx
 * const status = useConnectionStatus();
 * if (status.state === ConnectionState.AUTH_FAILED) {
 *     return <div>Authentication failed: {status.lastError}</div>;
 * }
 * if (status.retryAttempt > 0) {
 *     return <div>Reconnecting... (attempt {status.retryAttempt})</div>;
 * }
 * ```
 */
export function useConnectionStatus(): ConnectionStatus {
	const [status, setStatus] = useState<ConnectionStatus>(
		() => ConnectionManager.getInstance().getConnectionStatus(),
	);

	useEffect(() => {
		const cm = ConnectionManager.getInstance();

		// Sync initial state
		setStatus(cm.getConnectionStatus());

		// Subscribe to status changes
		// shell:statusChange payload is ConnectionStatus
		const unsub = cm.on('shell:statusChange', (newStatus) => {
			setStatus({ ...(newStatus as ConnectionStatus) });
		});

		return unsub;
	}, []);

	return status;
}
