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
// EXPLORER — SHELL BINDING (what wakes an endpoint store up)
// =============================================================================
//
// The one module, besides react.tsx, that imports a VALUE from 'shell'. It
// turns the platform's signals into the store's handlers:
//
//   task events      `apaevt_task` (begin / end / restart / running) arrives on
//                    `shell:event` once a `task` monitor is registered. The
//                    monitor is ref-counted by the client, so sharing the
//                    wildcard key `{token: '*'}` with other surfaces is safe.
//                    The event body names the task but not its owner, so ANY
//                    task event just asks for a (debounced) re-discovery; a
//                    `restart` additionally asks for a re-probe, because the
//                    node behind the same token may have changed. A `begin`
//                    or `restart` is sent while the task is still loading, so
//                    it also names the task (project id and source) for the
//                    store to look for until discovery lists it, and an `end`
//                    names the task to stop looking for (see readTaskEvent and
//                    store.ts, "A STARTED TASK IS LOOKED FOR").
//   window focus     `focus` and `visibilitychange` (the store rate-limits).
//   identity         the identity tracker (devtool/identity.ts): a sign-out or
//                    a different user / organization / team resets everything
//                    the store holds. NOT the shell's login / logout / org
//                    events: those fire only in the realm that owns the socket,
//                    never in a mirrored (VS Code webview) realm, whose sign-out
//                    arrives as the root's account topic going null. The tracker
//                    follows that topic where the bus has it, and the realm
//                    client otherwise.
//   reconnect        `shell:connected`: emitted in both realm kinds (the
//                    socket-owning one on its handshake, a mirrored one when the
//                    root's status mirror turns connected): events were missed.
//
// Task events (`shell:event`) reach a mirrored realm too: the VS Code host
// broadcasts the root's events as `mirror.event`, and each webview realm
// re-emits them as `shell:event` (busRealm.ts). The monitor that produces them
// is registered at the root through the realm client (`addMonitor`).
//
// Everything it registers is removed by the returned function.
// =============================================================================

import { ConnectionManager } from 'shell';
import type { ShellEventMap } from 'shell';
import { isPlainObject } from './checks';
import { createIdentityTracker } from './devtool/identity';
import type { IIdentityBus, IdentityEvent } from './devtool/identity';
import type { EndpointWatch, ITaskEventInfo } from './connect/store';
import type { IExplorerClient, ITaskRef } from './types';

/** The monitor key and event type that deliver task lifecycle events. */
const TASK_MONITOR_KEY = { token: '*' };
const TASK_MONITOR_TYPES = ['task'];

/** What the watch needs from a realm's ConnectionManager (structural: any realm's fits). */
export interface IShellWatchBus extends Omit<IIdentityBus, 'on'> {
	/** Follow a shell event; returns the unsubscribe function. */
	on<K extends IdentityEvent | 'shell:event'>(event: K, handler: (payload: ShellEventMap[K]) => void): () => void;
}

/**
 * The task an `apaevt_task` body names: its `projectId` (or the stamped
 * `project_id`) and its `source`.
 *
 * @param body - The event body.
 * @returns The task, or null when the body does not say which task.
 */
function taskRefOf(body: Record<string, unknown>): ITaskRef | null {
	const projectId = typeof body.projectId === 'string' ? body.projectId : typeof body.project_id === 'string' ? body.project_id : null;
	const source = typeof body.source === 'string' && body.source !== '' ? body.source : null;
	return projectId === null || source === null ? null : { projectId, source };
}

/**
 * Read one `shell:event` message as what it asks of the endpoint store.
 *
 * @param message - The message (anything; it arrives from the network).
 * @returns What the store is told, or null when it is not an `apaevt_task` event.
 */
export function readTaskEvent(message: unknown): ITaskEventInfo | null {
	if (!isPlainObject(message) || message.event !== 'apaevt_task') return null;
	const body = isPlainObject(message.body) ? message.body : null;
	const action = body?.action;
	const info: ITaskEventInfo = { reprobe: action === 'restart' };
	const ref = body === null ? null : taskRefOf(body);
	if (ref !== null && (action === 'begin' || action === 'restart')) info.started = ref;
	else if (ref !== null && action === 'end') info.ended = ref;
	return info;
}

/**
 * Build the watch an endpoint store attaches with.
 *
 * @param client - The shell's client (its monitors are ref-counted).
 * @param bus - The realm's ConnectionManager (default: the singleton; tests pass a fake realm's).
 * @returns A watch for `store.attach(client, identity, watch)`.
 */
export function createShellWatch(client: IExplorerClient, bus?: IShellWatchBus): EndpointWatch {
	return (handlers) => {
		const manager = bus ?? (ConnectionManager.getInstance() as unknown as IShellWatchBus);
		const unsubscribers: Array<() => void> = [];

		// Task events only flow once a task monitor exists; a failure to register
		// it only costs live updates (focus and explicit refresh still work).
		void client.addMonitor?.(TASK_MONITOR_KEY, TASK_MONITOR_TYPES)?.catch(() => undefined);

		unsubscribers.push(manager.on('shell:event', ({ event }) => {
			const info = readTaskEvent(event as unknown);
			if (info !== null) handlers.onTaskEvent(info);
		}));
		// Identity: the tracker, which handles both realm kinds (see the header).
		// It starts unknown until its first read answers, so the first snapshot is
		// ignored unless it differs from what the store was attached with.
		const tracker = createIdentityTracker({ cm: manager });
		unsubscribers.push(tracker.subscribe((snapshot) => handlers.onIdentity(snapshot.identity)));
		unsubscribers.push(() => tracker.dispose());
		unsubscribers.push(manager.on('shell:connected', () => handlers.onReconnect()));

		const onVisible = (): void => {
			if (typeof document === 'undefined' || document.visibilityState === 'visible') handlers.onFocus();
		};
		if (typeof window !== 'undefined') {
			window.addEventListener('focus', onVisible);
			window.addEventListener('visibilitychange', onVisible);
		}

		return () => {
			unsubscribers.forEach((unsubscribe) => unsubscribe());
			if (typeof window !== 'undefined') {
				window.removeEventListener('focus', onVisible);
				window.removeEventListener('visibilitychange', onVisible);
			}
			void client.removeMonitor?.(TASK_MONITOR_KEY, TASK_MONITOR_TYPES)?.catch(() => undefined);
		};
	};
}
