// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * MonitorManager — Reference-counted event subscription manager.
 *
 * Multiple VS Code providers share a single WebSocket connection, which means
 * they share a single server-side `_monitors` dictionary. The server uses
 * REPLACE semantics: setting the same key overwrites the previous bitmask.
 *
 * MonitorManager sits between providers and the raw `rrext_monitor` command.
 * It tracks subscriptions per key with reference-counted type strings, merges
 * them into a single bitmask per key, and sends the merged result to the server.
 *
 * Example:
 *   // Provider A wants TASK + OUTPUT on '*'
 *   await monitorManager.addMonitor({ token: '*' }, ['task', 'output']);
 *   // Server gets: * → TASK | OUTPUT
 *
 *   // Provider B also wants TASK + SUMMARY on '*'
 *   await monitorManager.addMonitor({ token: '*' }, ['task', 'summary']);
 *   // Server gets: * → TASK | OUTPUT | SUMMARY  (merged)
 *
 *   // Provider B closes, removes its subscription
 *   await monitorManager.removeMonitor({ token: '*' }, ['task', 'summary']);
 *   // Server gets: * → TASK | OUTPUT  (TASK refcount still 1 from Provider A)
 */

import { ConnectionManager } from './connection';
import { getLogger } from '../shared/util/output';

// ============================================================================
// Types
// ============================================================================

/**
 * Identifies a monitor subscription key.
 * Matches the server's key-building logic in cmd_monitor.py set_monitor().
 */
export type MonitorKey = { token: string } | { projectId: string; source: string; pipeId?: number };

// ============================================================================
// MonitorManager
// ============================================================================

export class MonitorManager {
	private static instance: MonitorManager;

	/**
	 * Per key-string: reference count for each event type.
	 * e.g. { '*': { 'task': 2, 'output': 1 }, 'p.abc.chat_1': { 'summary': 1, 'flow': 1 } }
	 */
	private keys = new Map<string, Map<string, number>>();

	private connectionManager = ConnectionManager.getInstance();
	private logger = getLogger();

	private constructor() {}

	public static getInstance(): MonitorManager {
		if (!MonitorManager.instance) {
			MonitorManager.instance = new MonitorManager();
		}
		return MonitorManager.instance;
	}

	/**
	 * Add a subscription. If the key already exists, the new types are merged
	 * via reference counting. The merged bitmask is sent to the server.
	 */
	public async addMonitor(key: MonitorKey, types: string[]): Promise<void> {
		const keyStr = this.keyToString(key);
		let refCounts = this.keys.get(keyStr);
		if (!refCounts) {
			refCounts = new Map();
			this.keys.set(keyStr, refCounts);
		}

		// Increment reference counts
		for (const t of types) {
			refCounts.set(t, (refCounts.get(t) ?? 0) + 1);
		}

		// Send merged types to server
		await this.syncKey(key, keyStr, refCounts);
	}

	/**
	 * Remove a subscription. Decrements reference counts for the given types.
	 * Only removes a type from the server when its refcount reaches 0.
	 * Unsubscribes from the server entirely when all types reach 0.
	 */
	public async removeMonitor(key: MonitorKey, types: string[]): Promise<void> {
		const keyStr = this.keyToString(key);
		const refCounts = this.keys.get(keyStr);
		if (!refCounts) return;

		// Decrement reference counts
		for (const t of types) {
			const current = refCounts.get(t) ?? 0;
			if (current <= 1) {
				refCounts.delete(t);
			} else {
				refCounts.set(t, current - 1);
			}
		}

		// Send merged types (or unsubscribe if empty)
		await this.syncKey(key, keyStr, refCounts);

		// Clean up empty keys
		if (refCounts.size === 0) {
			this.keys.delete(keyStr);
		}
	}

	/**
	 * Replay all active subscriptions to the server.
	 * Called after reconnection to restore server-side state.
	 */
	public async resubscribeAll(): Promise<void> {
		for (const [keyStr, refCounts] of this.keys) {
			if (refCounts.size === 0) continue;
			const key = this.stringToKey(keyStr);
			if (key) {
				try {
					await this.syncKey(key, keyStr, refCounts);
				} catch (error) {
					this.logger.error(`[MonitorManager] Failed to resubscribe ${keyStr}: ${error}`);
				}
			}
		}
	}

	/**
	 * Clear all tracked state. Called on disconnect.
	 * Does NOT send unsubscribe to server (connection is already gone).
	 */
	public clear(): void {
		this.keys.clear();
	}

	// ========================================================================
	// Internal
	// ========================================================================

	/**
	 * Send the merged type list for a key to the server.
	 */
	private async syncKey(key: MonitorKey, keyStr: string, refCounts: Map<string, number>): Promise<void> {
		if (!this.connectionManager.isConnected()) return;

		const mergedTypes = Array.from(refCounts.keys());

		try {
			if ('token' in key) {
				await this.connectionManager.request(
					'rrext_monitor',
					{
						types: mergedTypes,
					},
					key.token
				);
			} else {
				const args: Record<string, unknown> = {
					projectId: key.projectId,
					source: key.source,
					types: mergedTypes,
				};
				if (key.pipeId !== undefined) {
					args.pipeId = key.pipeId;
				}
				await this.connectionManager.request('rrext_monitor', args);
			}
		} catch (error) {
			this.logger.error(`[MonitorManager] Failed to sync ${keyStr} [${mergedTypes.join(',')}]: ${error}`);
		}
	}

	/**
	 * Convert a MonitorKey to a stable string for map lookup.
	 */
	private keyToString(key: MonitorKey): string {
		if ('token' in key) {
			return `t:${key.token}`;
		}
		let s = `p:${key.projectId}.${key.source}`;
		if (key.pipeId !== undefined) {
			s += `.${key.pipeId}`;
		}
		return s;
	}

	/**
	 * Reverse a key-string back to a MonitorKey (for resubscribeAll).
	 */
	private stringToKey(keyStr: string): MonitorKey | null {
		if (keyStr.startsWith('t:')) {
			return { token: keyStr.slice(2) };
		}
		if (keyStr.startsWith('p:')) {
			const rest = keyStr.slice(2);
			const dotIdx = rest.indexOf('.');
			if (dotIdx === -1) return null;
			const projectId = rest.slice(0, dotIdx);
			const remaining = rest.slice(dotIdx + 1);
			// Check for pipeId: source.pipeId
			const parts = remaining.split('.');
			if (parts.length === 2 && !isNaN(Number(parts[1]))) {
				return { projectId, source: parts[0], pipeId: Number(parts[1]) };
			}
			return { projectId, source: remaining };
		}
		return null;
	}
}
