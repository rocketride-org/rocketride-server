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
// EXPLORER DEV TOOL — ACTIVATION GATE (first discovery waits, R7)
// =============================================================================
//
// A controller must not discover (or register monitors, or probe) just
// because a host built it for no reason the user gave. The gate opens ONCE,
// on the first of:
//
//   lazyMount   the mount itself, in a realm whose kind is known (below)
//   activated   `shell:toolSidebarActivated` for this appId (useToolStrip)
//   op          the first op a frame sends (attachController onFirstOp)
//   activeDoc   an `activeDocKey` that is a string: '' is this tool's generic
//               frame; null means another tab is active, undefined that the
//               host cannot tell yet (VS Code before devtools:activeDoc)
//   user        an explicit action in the sidebar (`open('user')`)
//
// MOUNT IS THE FIRST ACTIVATION, in both hosts. Since #2625 9bd5d931f
// ("one tool mount"), rocket-ui and VS Code both build a store tool's
// sidebar only when its tab is first selected, or when one of its frames
// summons the controller (busPeer's `host.mountToolSidebar`), and keep it
// mounted afterwards (SidebarChrome's mounted-tool set). The selection's
// `shell:toolSidebarActivated` fires before the sidebar exists to hear it
// (it is not replayed; #2625 lists this as a known gap), so a gate that
// waited for it would leave a first-selected tool idle. Before that commit
// rocket-ui mounted every pinned sidebar at boot, which is what this gate
// was built against; that no longer happens.
//
// So the gate opens at mount in any realm it can classify: a client realm
// (rocket-ui) or a socketless one (a VS Code webview, see realm.ts). A
// clientless realm that is down cannot be classified yet, so the gate
// re-checks on `shell:connected`. Fallback: a bus that cannot be classified
// at all (no `getClient`) waits for the explicit signals.
// =============================================================================

import type { ShellEventMap } from 'shell';
import { realmKind } from './realm';

/** Why the gate opened. */
export type ActivationReason = 'activated' | 'op' | 'activeDoc' | 'user' | 'lazyMount';

/** The events the gate follows. */
export type ActivationEvent = 'shell:toolSidebarActivated' | 'shell:connected';

/** What the gate needs from a realm's ConnectionManager (structural). */
export interface IActivationBus {
	/** Follow a shell event; returns the unsubscribe function. */
	on<K extends ActivationEvent>(event: K, handler: (payload: ShellEventMap[K]) => void): () => void;
	/** Whether the realm is connected. */
	isConnected(): boolean;
	/** The realm's client (null in a socketless realm). */
	getClient?(): unknown;
}

/** What {@link createActivationGate} needs. */
export interface IActivationGateOptions {
	/** This tool's app id. */
	appId: string;
	/** The realm's ConnectionManager. */
	cm: IActivationBus;
	/** The sidebar's `activeDocKey` prop at mount. */
	activeDocKey?: string | null;
}

/** The gate. */
export interface IActivationGate {
	/** Whether the controller may start its first discovery. */
	isOpen(): boolean;
	/** Why it opened, or null while closed. */
	reason(): ActivationReason | null;
	/** Open it (a no-op once open). Lanes call `open('user')` on sidebar actions, `open('op')` on the first frame op. */
	open(reason: ActivationReason): void;
	/** Feed every new `activeDocKey` prop value. */
	noteActiveDocKey(key: string | null | undefined): void;
	/** Be told once, when it opens (at once if it already is); returns unsubscribe. */
	subscribe(cb: (reason: ActivationReason) => void): () => void;
	/** Stop following the realm (idempotent). */
	dispose(): void;
}

/**
 * Build a controller's activation gate.
 *
 * @param opts - See {@link IActivationGateOptions}.
 * @returns The gate.
 */
export function createActivationGate(opts: IActivationGateOptions): IActivationGate {
	const { appId, cm } = opts;
	let opened: ActivationReason | null = null;
	const listeners = new Set<(reason: ActivationReason) => void>();
	const offs: Array<() => void> = [];
	let disposed = false;

	const open = (reason: ActivationReason): void => {
		if (opened !== null || disposed) return;
		opened = reason;
		for (const off of offs.splice(0)) off();
		for (const listener of [...listeners]) listener(reason);
		listeners.clear();
	};

	const noteActiveDocKey = (key: string | null | undefined): void => {
		if (typeof key === 'string') open('activeDoc');
	};

	// Mounting is the activation wherever the realm can be classified (see the header).
	const checkLazyMount = (): void => {
		if (realmKind(cm) !== 'unknown') open('lazyMount');
	};

	offs.push(cm.on('shell:toolSidebarActivated', (payload: unknown) => {
		const target = payload !== null && typeof payload === 'object' ? (payload as { appId?: unknown }).appId : undefined;
		if (target === appId) open('activated');
	}));
	// The payload may be undefined in a mirrored realm: never read it.
	offs.push(cm.on('shell:connected', () => checkLazyMount()));

	checkLazyMount();
	noteActiveDocKey(opts.activeDocKey);

	return {
		isOpen: () => opened !== null,
		reason: () => opened,
		open,
		noteActiveDocKey,
		subscribe(cb) {
			if (opened !== null) {
				cb(opened);
				return () => undefined;
			}
			listeners.add(cb);
			return () => { listeners.delete(cb); };
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const off of offs.splice(0)) off();
			listeners.clear();
		},
	};
}
